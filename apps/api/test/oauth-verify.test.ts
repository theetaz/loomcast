import { createHmac, randomBytes } from "node:crypto";
import { DAILY_TASK_INTERVAL_MS, type Platform } from "@loomcast/contracts";
import { channels, oauthStates, scheduledTasks } from "@loomcast/db";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  answer,
  createOAuthHarness,
  GRAPH_VERSION,
  graphError,
  type OAuthHarness,
  type SeenRequest,
} from "./oauth-support";
import { insertChannel, runDue } from "./publisher-support";

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

function meta() {
  if (h.meta === null) {
    throw new Error("the harness has no Meta app");
  }
  return h.meta;
}

async function connected(platform: Platform): Promise<{ id: string; token: string }> {
  const keyring = h.t.deps.config.encryption;
  if (keyring === null) {
    throw new Error("no vault key");
  }
  const inserted = await insertChannel(h.db, keyring, { platform, connected: true });
  return { id: inserted.id, token: inserted.token ?? "" };
}

async function channel(id: string) {
  const [row] = await h.db.select().from(channels).where(eq(channels.id, id));
  if (row === undefined) {
    throw new Error("no channel");
  }
  return row;
}

let counter = 0;

/** Runs `channel.verify` for one channel, or the daily sweep. Returns the task's dedupe key. */
async function verify(channelId?: string): Promise<string> {
  counter += 1;
  const dedupeKey = `test:verify:${counter}`;
  await h.deps.scheduler.enqueue("channel.verify", channelId === undefined ? {} : { channelId }, {
    dedupeKey,
  });
  await runDue(h.deps.scheduler);
  return dedupeKey;
}

async function tasks(dedupeKey: string) {
  return h.db
    .select()
    .from(scheduledTasks)
    .where(and(eq(scheduledTasks.kind, "channel.verify"), eq(scheduledTasks.dedupeKey, dedupeKey)));
}

function debugReply(data: Record<string, unknown>) {
  return { body: { data: { app_id: meta().appId, type: "PAGE", ...data } } };
}

describe("channel.verify", () => {
  it("checks a Page token with debug_token and records the check", async () => {
    const page = await connected("facebook");
    await h.db
      .update(channels)
      .set({ lastError: { code: "transient", retryable: true, message: "Earlier failure" } })
      .where(eq(channels.id, page.id));
    const seen: SeenRequest[] = [];
    answer(
      h.graph,
      "GET",
      `/${GRAPH_VERSION}/debug_token`,
      debugReply({ is_valid: true, expires_at: 0, scopes: ["pages_manage_posts"] }),
      seen,
    );
    await verify(page.id);
    const appToken = `${meta().appId}|${meta().appSecret}`;
    expect(seen[0]?.query.get("input_token")).toBe(page.token);
    expect(seen[0]?.headers.authorization).toBe(`Bearer ${appToken}`);
    expect(seen[0]?.query.get("appsecret_proof")).toBe(
      createHmac("sha256", meta().appSecret).update(appToken).digest("hex"),
    );
    const row = await channel(page.id);
    expect(row.status).toBe("active");
    expect(row.lastError).toBeNull();
    expect(row.lastVerifiedAt?.getTime()).toBe(h.t.clock.now().getTime());
    expect(row.scopes).toEqual(["pages_manage_posts"]);
  });

  it("flags an invalid Instagram token as needs_reauth with an event and an alert", async () => {
    const ig = await connected("instagram");
    answer(
      h.graph,
      "GET",
      `/${GRAPH_VERSION}/debug_token`,
      debugReply({
        is_valid: false,
        error: { code: 190, subcode: 460, message: "The session has been invalidated." },
      }),
    );
    await verify(ig.id);
    const row = await channel(ig.id);
    expect(row.status).toBe("needs_reauth");
    expect(row.lastError).toMatchObject({
      code: "auth",
      retryable: false,
      platformCode: "190/460",
    });
    expect(row.secretCiphertext).not.toBeNull();
    expect(
      h.live.some(
        (event) =>
          event.type === "channel.updated" &&
          event.payload.channel.id === ig.id &&
          event.payload.channel.status === "needs_reauth" &&
          event.payload.channel.lastError?.code === "auth",
      ),
    ).toBe(true);
    const alert = h.alerts.find((entry) => entry.key === `channel.reauth:${ig.id}`);
    expect(alert).toMatchObject({
      title: "A channel needs reconnecting",
      data: { channelId: ig.id, code: "auth" },
    });
    expect(JSON.stringify(alert)).not.toContain(ig.token);

    // A later check that passes turns the channel active again.
    answer(h.graph, "GET", `/${GRAPH_VERSION}/debug_token`, debugReply({ is_valid: true }));
    await verify(ig.id);
    expect((await channel(ig.id)).status).toBe("active");
  });

  it("does not blame the channel when the app token itself is refused", async () => {
    const page = await connected("facebook");
    answer(h.graph, "GET", `/${GRAPH_VERSION}/debug_token`, {
      status: 400,
      body: graphError(190, "Invalid OAuth access token signature."),
    });
    const key = await verify(page.id);
    const [task] = await tasks(key);
    expect(task?.status).toBe("failed");
    expect(task?.lastError).toMatchObject({ code: "platform_auth" });
    expect((await channel(page.id)).status).toBe("active");
  });

  it("checks a Threads token by reading its profile", async () => {
    const profile = await connected("threads");
    const seen: SeenRequest[] = [];
    answer(h.threadsApi, "GET", "/v1.0/me", { body: { id: "1", username: "x" } }, seen);
    await verify(profile.id);
    expect(seen[0]?.query.get("access_token")).toBe(profile.token);
    expect((await channel(profile.id)).lastVerifiedAt).not.toBeNull();

    answer(h.threadsApi, "GET", "/v1.0/me", {
      status: 400,
      body: graphError(190, "Error validating access token."),
    });
    await verify(profile.id);
    expect((await channel(profile.id)).status).toBe("needs_reauth");
  });

  it("sweeps every active channel, purges expired sign-ins and queues the next sweep", async () => {
    await h.db.update(channels).set({ status: "disabled" }).where(eq(channels.status, "active"));
    const page = await connected("facebook");
    const threadsChannel = await connected("threads");
    const [expired] = await h.db
      .insert(oauthStates)
      .values({
        stateHash: randomBytes(32).toString("hex"),
        provider: "meta",
        userId: h.userId,
        createdAt: new Date(h.t.clock.now().getTime() - 60 * 60_000),
        expiresAt: new Date(h.t.clock.now().getTime() - 30 * 60_000),
      })
      .returning({ id: oauthStates.id });

    answer(h.graph, "GET", `/${GRAPH_VERSION}/debug_token`, debugReply({ is_valid: true }));
    // A throttled check of one channel does not stop the sweep.
    answer(h.threadsApi, "GET", "/v1.0/me", {
      status: 400,
      body: graphError(4, "Application request limit reached"),
    });
    const key = await verify();

    expect((await channel(page.id)).lastVerifiedAt).not.toBeNull();
    const threadsRow = await channel(threadsChannel.id);
    expect(threadsRow.status).toBe("active");
    expect(threadsRow.lastVerifiedAt).toBeNull();
    const [done, next] = await tasks(key);
    expect(done?.status).toBe("succeeded");
    expect(next?.status).toBe("pending");
    expect(next?.runAt.getTime()).toBe(h.t.clock.now().getTime() + DAILY_TASK_INTERVAL_MS);
    expect(
      await h.db
        .select()
        .from(oauthStates)
        .where(eq(oauthStates.id, expired?.id ?? "")),
    ).toEqual([]);
  });

  it("never writes a channel token to the log", () => {
    expect(h.t.logs.join("\n")).not.toMatch(/tok-[0-9a-f-]{36}/);
    expect(h.t.logs.join("\n")).not.toContain(meta().appSecret);
  });
});
