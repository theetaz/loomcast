import {
  type Channel,
  DAILY_TASK_INTERVAL_MS,
  OAUTH_CONNECT_PAGE_PATH,
  TOKEN_REFRESH_LEAD_MS,
} from "@loomcast/contracts";
import { auditLog, channels, scheduledTasks } from "@loomcast/db";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { channelAad, createVault, sealedSecretOf } from "../src/lib/vault";
import { channelSweepDedupeKey } from "../src/modules/channels";
import {
  answer,
  createOAuthHarness,
  fakeCredential,
  fakeId,
  formOf,
  graphError,
  type OAuthHarness,
  type SeenRequest,
} from "./oauth-support";
import { insertChannel, runDue, testKeyring } from "./publisher-support";
import { send } from "./support";

const DAY_MS = 24 * 60 * 60_000;
const SIXTY_DAYS_S = 60 * 24 * 60 * 60;

let h: OAuthHarness;

beforeAll(async () => {
  h = await createOAuthHarness();
});

afterAll(async () => {
  await h.close();
});

afterEach(() => {
  h.agent.assertNoPendingInterceptors();
});

function threads() {
  if (h.threads === null) {
    throw new Error("the harness has no Threads app");
  }
  return h.threads;
}

function vault() {
  const keyring = h.t.deps.config.encryption;
  if (keyring === null) {
    throw new Error("no vault key");
  }
  return createVault(keyring);
}

async function secretOf(channelId: string) {
  const [row] = await h.db.select().from(channels).where(eq(channels.id, channelId));
  const sealed = row === undefined ? null : sealedSecretOf(row);
  return sealed === null ? null : vault().decrypt(sealed, channelAad(channelId));
}

describe("threads sign-in", () => {
  it("authorizes, exchanges for a long-lived token and connects the profile", async () => {
    const started = await send(h.t.app, "GET", "/api/oauth/threads/start", { cookie: h.cookie });
    expect(started.status).toBe(302);
    const location = new URL(started.headers.get("location") ?? "");
    expect(`${location.origin}${location.pathname}`).toBe("https://threads.com/oauth/authorize");
    expect(location.searchParams.get("client_id")).toBe(threads().appId);
    expect(location.searchParams.get("scope")).toBe(
      "threads_basic,threads_content_publish,threads_manage_insights",
    );
    expect(location.searchParams.get("response_type")).toBe("code");
    const redirectUri = "https://loomcast.example.test/api/oauth/threads/callback";
    expect(location.searchParams.get("redirect_uri")).toBe(redirectUri);
    const state = location.searchParams.get("state") ?? "";

    const code = fakeCredential("code");
    const shortToken = fakeCredential("short");
    const longToken = fakeCredential("long");
    const profile = { id: fakeId(), username: `loomcast_${fakeId()}` };
    const seen: SeenRequest[] = [];
    answer(
      h.threadsApi,
      "POST",
      "/oauth/access_token",
      { body: { access_token: shortToken, user_id: Number(profile.id) } },
      seen,
    );
    answer(
      h.threadsApi,
      "GET",
      "/access_token",
      { body: { access_token: longToken, token_type: "bearer", expires_in: SIXTY_DAYS_S } },
      seen,
    );
    answer(h.threadsApi, "GET", "/v1.0/me", { body: profile }, seen);

    const callback = await send(
      h.t.app,
      "GET",
      `/api/oauth/threads/callback?${new URLSearchParams({ code, state })}`,
      { cookie: h.cookie },
    );
    expect(callback.status).toBe(302);
    const target = new URL(callback.headers.get("location") ?? "", "https://app.invalid");
    const connection = target.searchParams.get("connection") ?? "";
    expect(target.searchParams.get("provider")).toBe("threads");

    const [exchange, longLived, me] = seen;
    const form = await formOf(exchange);
    expect(form.get("client_id")).toBe(threads().appId);
    expect(form.get("client_secret")).toBe(threads().appSecret);
    expect(form.get("code")).toBe(code);
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("redirect_uri")).toBe(redirectUri);
    expect(longLived?.query.get("grant_type")).toBe("th_exchange_token");
    expect(longLived?.query.get("client_secret")).toBe(threads().appSecret);
    expect(longLived?.query.get("access_token")).toBe(shortToken);
    expect(me?.query.get("fields")).toBe("id,username,threads_profile_picture_url");
    expect(me?.query.get("access_token")).toBe(longToken);
    expect(me?.query.has("appsecret_proof")).toBe(false);

    const accepted = await send(h.t.app, "POST", `/api/oauth/connections/${connection}/accept`, {
      cookie: h.cookie,
      body: { workspaceId: h.workspaceId, accountIds: [`threads:${profile.id}`] },
    });
    expect(accepted.status).toBe(200);
    const text = await accepted.text();
    expect(text).not.toContain(longToken);
    const { channels: created } = JSON.parse(text) as { channels: Channel[] };
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      platform: "threads",
      externalId: profile.id,
      username: profile.username,
      displayName: profile.username,
      status: "active",
      dryRun: true,
      connected: true,
      scopes: ["threads_basic", "threads_content_publish", "threads_manage_insights"],
      tokenExpiresAt: new Date(h.t.clock.now().getTime() + SIXTY_DAYS_S * 1000).toISOString(),
    });
    expect(await secretOf(created[0]?.id ?? "")).toMatchObject({
      accessToken: longToken,
      provider: "threads",
    });

    // Connecting queues the daily sweeps, a day out.
    const sweeps = await h.db
      .select()
      .from(scheduledTasks)
      .where(eq(scheduledTasks.dedupeKey, channelSweepDedupeKey("channel.refresh_token")));
    expect(sweeps).toHaveLength(1);
    expect(sweeps[0]?.runAt.getTime()).toBe(h.t.clock.now().getTime() + DAILY_TASK_INTERVAL_MS);
  });

  it("reports a refused code exchange as provider_error", async () => {
    const started = await send(h.t.app, "GET", "/api/oauth/threads/start", { cookie: h.cookie });
    const state = new URL(started.headers.get("location") ?? "").searchParams.get("state") ?? "";
    answer(h.threadsApi, "POST", "/oauth/access_token", {
      status: 400,
      body: graphError(1, "Invalid code"),
    });
    const callback = await send(
      h.t.app,
      "GET",
      `/api/oauth/threads/callback?${new URLSearchParams({ code: fakeCredential("code"), state })}`,
      { cookie: h.cookie },
    );
    expect(callback.headers.get("location")).toBe(
      `${OAUTH_CONNECT_PAGE_PATH}?error=provider_error&provider=threads`,
    );
  });
});

describe("channel.refresh_token", () => {
  /** A connected Threads channel whose token expires `inMs` from now. */
  async function threadsChannel(inMs: number): Promise<{ id: string; token: string }> {
    const keyring = h.t.deps.config.encryption ?? testKeyring();
    const inserted = await insertChannel(h.db, keyring, { platform: "threads", connected: true });
    await h.db
      .update(channels)
      .set({ tokenExpiresAt: new Date(h.t.clock.now().getTime() + inMs) })
      .where(eq(channels.id, inserted.id));
    return { id: inserted.id, token: inserted.token ?? "" };
  }

  async function refresh(channelId?: string): Promise<void> {
    await h.deps.scheduler.enqueue(
      "channel.refresh_token",
      channelId === undefined ? {} : { channelId },
      { dedupeKey: channelId === undefined ? "test:sweep" : `test:refresh:${channelId}` },
    );
    await runDue(h.deps.scheduler);
  }

  async function taskOf(dedupeKey: string) {
    const rows = await h.db
      .select()
      .from(scheduledTasks)
      .where(
        and(
          eq(scheduledTasks.kind, "channel.refresh_token"),
          eq(scheduledTasks.dedupeKey, dedupeKey),
        ),
      );
    return rows;
  }

  it("leaves tokens with more than 15 days left and queues the next sweep a day later", async () => {
    const lead = TOKEN_REFRESH_LEAD_MS.threads;
    const fresh = await threadsChannel(lead + DAY_MS);
    await refresh(fresh.id);
    expect((await secretOf(fresh.id))?.accessToken).toBe(fresh.token);

    await h.db.update(channels).set({ status: "disabled" }).where(eq(channels.id, fresh.id));
    await refresh();
    const [sweep, next] = await taskOf("test:sweep");
    expect(sweep?.status).toBe("succeeded");
    expect(next?.status).toBe("pending");
    expect(next?.runAt.getTime()).toBe(h.t.clock.now().getTime() + DAILY_TASK_INTERVAL_MS);
    await h.db.delete(scheduledTasks).where(eq(scheduledTasks.dedupeKey, "test:sweep"));
  });

  it("refreshes a token with less than 15 days left and stores the new one", async () => {
    const soon = await threadsChannel(TOKEN_REFRESH_LEAD_MS.threads - DAY_MS);
    const newToken = fakeCredential("refreshed");
    const seen: SeenRequest[] = [];
    answer(
      h.threadsApi,
      "GET",
      "/refresh_access_token",
      { body: { access_token: newToken, token_type: "bearer", expires_in: SIXTY_DAYS_S } },
      seen,
    );
    await refresh(soon.id);
    expect(seen[0]?.query.get("grant_type")).toBe("th_refresh_token");
    expect(seen[0]?.query.get("access_token")).toBe(soon.token);
    expect((await secretOf(soon.id))?.accessToken).toBe(newToken);
    const [row] = await h.db.select().from(channels).where(eq(channels.id, soon.id));
    expect(row?.tokenExpiresAt?.getTime()).toBe(h.t.clock.now().getTime() + SIXTY_DAYS_S * 1000);
    expect(row?.status).toBe("active");
    const actions = await h.db.select().from(auditLog).where(eq(auditLog.targetId, soon.id));
    expect(actions.map((entry) => entry.action)).toContain("channel.token_refreshed");
    expect(JSON.stringify(actions)).not.toContain(newToken);
    expect(h.t.logs.join("\n")).not.toContain(newToken);
  });

  it("flags a refused refresh as needs_reauth with an event and an alert", async () => {
    const soon = await threadsChannel(DAY_MS);
    answer(h.threadsApi, "GET", "/refresh_access_token", {
      status: 400,
      body: graphError(190, "Error validating access token: Session has expired.", 463),
    });
    await refresh(soon.id);
    const [row] = await h.db.select().from(channels).where(eq(channels.id, soon.id));
    expect(row?.status).toBe("needs_reauth");
    expect(row?.lastError).toMatchObject({
      code: "auth",
      retryable: false,
      platformCode: "190/463",
    });
    expect((await secretOf(soon.id))?.accessToken).toBe(soon.token);
    expect(
      h.live.some(
        (event) =>
          event.type === "channel.updated" &&
          event.payload.channel.id === soon.id &&
          event.payload.channel.status === "needs_reauth",
      ),
    ).toBe(true);
    const alert = h.alerts.find((entry) => entry.key === `channel.reauth:${soon.id}`);
    expect(alert).toMatchObject({
      title: "A channel needs reconnecting",
      data: { channelId: soon.id, code: "auth" },
    });
    expect(JSON.stringify(alert)).not.toContain(soon.token);
    expect(h.t.logs.join("\n")).not.toContain(soon.token);
  });

  it("flags an expired token without calling the platform", async () => {
    const expired = await threadsChannel(-DAY_MS);
    await refresh(expired.id);
    const [row] = await h.db.select().from(channels).where(eq(channels.id, expired.id));
    expect(row?.status).toBe("needs_reauth");
    expect(row?.lastError?.code).toBe("auth");
  });

  it("retries a throttled refresh later", async () => {
    const soon = await threadsChannel(DAY_MS);
    answer(h.threadsApi, "GET", "/refresh_access_token", {
      status: 400,
      body: graphError(4, "Application request limit reached"),
    });
    await refresh(soon.id);
    const [task] = await taskOf(`test:refresh:${soon.id}`);
    expect(task?.status).toBe("pending");
    expect(task?.lastError).toMatchObject({ code: "platform_rate_limited" });
    const [row] = await h.db.select().from(channels).where(eq(channels.id, soon.id));
    expect(row?.status).toBe("active");
    await h.db.delete(scheduledTasks).where(eq(scheduledTasks.id, task?.id ?? ""));
  });
});
