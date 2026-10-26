import { randomBytes, randomUUID } from "node:crypto";
import type { Channel, PublishingMode } from "@loomcast/contracts";
import { assets, auditLog, channels, publishAttempts, scheduledPosts } from "@loomcast/db";
import { and, eq } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  type MockInstance,
  vi,
} from "vitest";
import type { ModuleDeps } from "../src/deps";
import type { PlatformsConfig, XAppConfig } from "../src/env";
import { channelAad, createVault, sealedSecretOf } from "../src/lib/vault";
import { isLivePlatformAvailable, livePublishingBlocker } from "../src/modules/publisher";
import { X_TOKEN_REFRESH_LEAD_MS } from "../src/modules/publisher/adapters/x";
import {
  answer,
  fakeCredential,
  fakeId,
  formOf,
  installMockAgent,
  type SeenRequest,
} from "./oauth-support";
import {
  createPipelineHarness,
  eventsOf,
  insertItem,
  insertWorkspace,
  type PipelineHarness,
} from "./pipeline-support";
import { appWith, enqueuePublish, insertPost, runDue, testKeyring } from "./publisher-support";
import { fakeStorageTarget, plantObject, type StorageTarget } from "./storage-support";
import { send, type TestApp } from "./support";

// The X adapter wired into the app: channel availability, `channels.create`, the daily
// `channel.refresh_token` sweep and the publisher all follow `FEATURE_X_PUBLISHING`. Every X API
// call is answered by an undici `MockAgent` that refuses the network, and a spy on the global
// `fetch` records every call to the X API host. With the flag off a catch-all interceptor also
// counts calls to it: both must stay at zero.

const API_ORIGIN = "https://api.x.com";
const keyring = testKeyring();
const vault = createVault(keyring);

function platforms(input: { flag: boolean; app: XAppConfig | null }): PlatformsConfig {
  return {
    redirectBase: "https://loomcast.example.test",
    metaGraphVersion: "v26.0",
    metaGraphBaseUrl: "https://graph.facebook.com",
    threadsGraphBaseUrl: "https://graph.threads.net",
    meta: null,
    threads: null,
    xPublishing: input.flag,
    x: input.app,
    xApiBaseUrl: API_ORIGIN,
  };
}

function fakeApp(): XAppConfig {
  return { clientId: fakeCredential("client"), clientSecret: fakeCredential("client-secret") };
}

interface XServer {
  h: PipelineHarness;
  t: TestApp;
  deps: ModuleDeps;
  workspaceId: string;
  storage: StorageTarget;
  close(): Promise<void>;
}

/** A server publishing live with the given X settings, on its own database and fake store. */
async function xServer(settings: { flag: boolean; app: XAppConfig | null }): Promise<XServer> {
  const h = await createPipelineHarness();
  const workspaceId = await insertWorkspace(h);
  const storage = await fakeStorageTarget();
  const { t, deps } = appWith(h.db, {
    clock: h.t.clock,
    config: {
      encryption: keyring,
      publishing: { mode: "live", enabled: true },
      storage: storage.config,
      platforms: platforms(settings),
    },
  });
  t.bus.subscribeLive((event) => void h.live.push(event));
  return {
    h,
    t,
    deps,
    workspaceId,
    storage,
    async close() {
      await t.deps.lifecycle.close();
      await h.close();
      await storage.close();
    },
  };
}

interface XChannel {
  id: string;
  externalId: string;
  accessToken: string;
  refreshToken: string;
}

/** A connected, active, live X channel whose access token expires `expiresInMs` from now. */
async function insertXChannel(server: XServer, expiresInMs: number): Promise<XChannel> {
  const id = randomUUID();
  const accessToken = fakeCredential("access");
  const refreshToken = fakeCredential("refresh");
  const externalId = fakeId();
  await server.h.db.insert(channels).values({
    id,
    workspaceId: server.workspaceId,
    platform: "x",
    displayName: "X channel",
    externalId,
    username: "loomcast",
    status: "active",
    dryRun: false,
    ...vault.encrypt({ accessToken, refreshToken, provider: "x" }, channelAad(id)),
    tokenExpiresAt: new Date(server.t.clock.now().getTime() + expiresInMs),
  });
  return { id, externalId, accessToken, refreshToken };
}

async function channelRow(server: XServer, id: string) {
  const [row] = await server.h.db.select().from(channels).where(eq(channels.id, id));
  if (row === undefined) {
    throw new Error("no channel");
  }
  const sealed = sealedSecretOf(row);
  return { row, secret: sealed === null ? null : vault.decrypt(sealed, channelAad(id)) };
}

/** Runs the daily sweep (or one channel's refresh) on the server's own scheduler. */
async function refreshSweep(server: XServer, channelId?: string): Promise<void> {
  await server.deps.scheduler.enqueue(
    "channel.refresh_token",
    channelId === undefined ? {} : { channelId },
    { dedupeKey: `test:refresh:${channelId ?? "sweep"}:${randomUUID()}` },
  );
  await runDue(server.deps.scheduler);
}

/** A live post of a rendered, scheduled item on `channelId`, its render stored in the bucket. */
async function livePost(server: XServer, channelId: string) {
  const item = await insertItem(server.h, {
    workspaceId: server.workspaceId,
    state: "scheduled",
    level: "render",
  });
  const [render] = await server.h.db
    .select()
    .from(assets)
    .where(eq(assets.id, item.renderAssetId ?? ""));
  if (render === undefined) {
    throw new Error("no render");
  }
  const bytes = randomBytes(render.bytes);
  await plantObject(server.storage, render.storageKey, bytes, render.mime);
  const postId = await insertPost(server.h.db, {
    itemId: item.itemId,
    versionId: item.versionId,
    channelId,
    scheduledAt: server.t.clock.now(),
    dryRun: false,
  });
  return { postId, bytes };
}

async function postRow(server: XServer, id: string) {
  const [row] = await server.h.db.select().from(scheduledPosts).where(eq(scheduledPosts.id, id));
  if (row === undefined) {
    throw new Error("no post");
  }
  return row;
}

/** Every `fetch` to the X API host, through a spy that passes calls on to the mock agent. */
function spyOnX(): { spy: MockInstance<typeof fetch>; calls: () => string[] } {
  const spy = vi.spyOn(globalThis, "fetch");
  return {
    spy,
    calls: () =>
      spy.mock.calls
        .map(([input]) =>
          input instanceof Request ? input.url : input instanceof URL ? input.href : input,
        )
        .filter((url) => url.startsWith(API_ORIGIN)),
  };
}

const MODES: readonly PublishingMode[] = ["live", "dry-run"];

/** The raw body of a call the mock answered, readable once the call has completed. */
async function bodyOf(request: SeenRequest | undefined): Promise<Buffer> {
  const body = request?.body;
  if (typeof body === "string") {
    return Buffer.from(body);
  }
  if (body instanceof Uint8Array) {
    return Buffer.from(body);
  }
  if (body !== null && typeof body === "object" && Symbol.asyncIterator in body) {
    const chunks: Buffer[] = [];
    for await (const chunk of body as AsyncIterable<Uint8Array | string>) {
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  return Buffer.alloc(0);
}

describe("x wiring with the flag off", () => {
  let mock: ReturnType<typeof installMockAgent>;
  let fetches: ReturnType<typeof spyOnX>;
  let reached = 0;

  beforeAll(() => {
    mock = installMockAgent();
    mock.agent
      .get(API_ORIGIN)
      .intercept({ path: () => true, method: () => true })
      .reply(() => {
        reached += 1;
        return { statusCode: 500, data: "{}" };
      })
      .persist();
    fetches = spyOnX();
  });

  afterAll(async () => {
    fetches.spy.mockRestore();
    await mock.restore();
  });

  afterEach(() => {
    expect(fetches.calls()).toEqual([]);
    expect(reached).toBe(0);
  });

  // Off by default, off with an app configured, on without an app: all must behave the same.
  for (const [label, settings] of [
    ["with an X app configured", { flag: false, app: fakeApp() }],
    ["without an X app", { flag: false, app: null }],
    ["with the flag on but no X app", { flag: true, app: null }],
  ] as const) {
    describe(label, () => {
      let server: XServer;

      beforeAll(async () => {
        server = await xServer(settings);
      });

      afterAll(async () => {
        await server.close();
      });

      it("reports X as unavailable", async () => {
        const config = platforms(settings);
        expect(isLivePlatformAvailable("x", config)).toBe(false);
        for (const platform of ["instagram", "facebook", "threads"] as const) {
          expect(isLivePlatformAvailable(platform, config)).toBe(true);
        }
        for (const mode of MODES) {
          expect(
            livePublishingBlocker(
              { platform: "x", status: "active", connected: true },
              { publishing: { mode }, platforms: config },
            ),
          ).toBe("platform_unavailable");
        }

        const channel = await insertXChannel(server, 60 * 60_000);
        const listed = await send(
          server.t.app,
          "GET",
          `/api/workspaces/${server.workspaceId}/channels`,
          {
            cookie: server.h.cookie,
          },
        );
        const { items } = (await listed.json()) as { items: Channel[] };
        expect(items.find((item) => item.id === channel.id)?.liveBlocker).toBe(
          "platform_unavailable",
        );
        await server.h.db.update(channels).set({ dryRun: true }).where(eq(channels.id, channel.id));
        const locked = await send(server.t.app, "PATCH", `/api/channels/${channel.id}`, {
          cookie: server.h.cookie,
          body: { dryRun: false },
        });
        expect(locked.status).toBe(409);
        expect(await locked.json()).toMatchObject({
          error: { code: "dry_run_locked", details: { reason: "platform_unavailable" } },
        });
      });

      it("refuses to create an X channel with 403 forbidden", async () => {
        const before = await server.h.db.select().from(channels).where(eq(channels.platform, "x"));
        const response = await send(
          server.t.app,
          "POST",
          `/api/workspaces/${server.workspaceId}/channels`,
          {
            cookie: server.h.cookie,
            body: { platform: "x", displayName: "X planning" },
          },
        );
        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({
          error: { code: "forbidden", message: "X publishing is turned off on this server." },
        });
        expect(
          await server.h.db.select().from(channels).where(eq(channels.platform, "x")),
        ).toHaveLength(before.length);

        const other = await send(
          server.t.app,
          "POST",
          `/api/workspaces/${server.workspaceId}/channels`,
          {
            cookie: server.h.cookie,
            body: { platform: "threads", displayName: "Threads planning" },
          },
        );
        expect(other.status).toBe(201);
      });

      it("skips X channels in the refresh sweep without calling X", async () => {
        const expired = await insertXChannel(server, -60_000);
        const soon = await insertXChannel(server, X_TOKEN_REFRESH_LEAD_MS - 60_000);
        await refreshSweep(server);
        await refreshSweep(server, soon.id);
        for (const channel of [expired, soon]) {
          const { row, secret } = await channelRow(server, channel.id);
          expect(row.status).toBe("active");
          expect(row.lastError).toBeNull();
          expect(secret).toMatchObject({
            accessToken: channel.accessToken,
            refreshToken: channel.refreshToken,
          });
        }
        const refreshed = await server.h.db
          .select()
          .from(auditLog)
          .where(eq(auditLog.action, "channel.token_refreshed"));
        expect(refreshed).toEqual([]);
      });

      it("refuses live X posts with not_configured", async () => {
        const channel = await insertXChannel(server, 60 * 60_000);
        const { postId } = await livePost(server, channel.id);
        await enqueuePublish(server.deps.scheduler, postId, server.t.clock.now());
        await runDue(server.deps.scheduler);
        const post = await postRow(server, postId);
        expect(post.status).toBe("failed");
        expect(post.externalId).toBeNull();
        expect(post.lastError).toMatchObject({ code: "not_configured", retryable: false });
        expect(post.lastError?.message).toContain("platform_unavailable");
        const attempts = await server.h.db
          .select()
          .from(publishAttempts)
          .where(and(eq(publishAttempts.postId, postId), eq(publishAttempts.dryRun, false)));
        // The gate refuses before an adapter is chosen: no live attempt sent anything.
        for (const attempt of attempts) {
          expect(attempt.response).toBeNull();
        }
      });
    });
  }
});

describe("x wiring with the flag on", () => {
  const app = fakeApp();
  let server: XServer;
  let mock: ReturnType<typeof installMockAgent>;
  let fetches: ReturnType<typeof spyOnX>;

  beforeAll(async () => {
    server = await xServer({ flag: true, app });
    mock = installMockAgent();
    fetches = spyOnX();
  });

  afterAll(async () => {
    fetches.spy.mockRestore();
    await mock.restore();
    await server.close();
  });

  afterEach(() => {
    mock.agent.assertNoPendingInterceptors();
    fetches.spy.mockClear();
  });

  function tokenReply(pair: { access: string; refresh: string }) {
    return {
      body: {
        token_type: "bearer",
        access_token: pair.access,
        refresh_token: pair.refresh,
        expires_in: 7_200,
        scope: "tweet.read tweet.write users.read media.write offline.access",
      },
    };
  }

  it("reports X as available", async () => {
    const config = platforms({ flag: true, app });
    expect(isLivePlatformAvailable("x", config)).toBe(true);
    expect(
      livePublishingBlocker(
        { platform: "x", status: "active", connected: true },
        { publishing: { mode: "live" }, platforms: config },
      ),
    ).toBeNull();

    const channel = await insertXChannel(server, 60 * 60_000);
    const listed = await send(
      server.t.app,
      "GET",
      `/api/workspaces/${server.workspaceId}/channels`,
      { cookie: server.h.cookie },
    );
    const { items } = (await listed.json()) as { items: Channel[] };
    expect(items.find((item) => item.id === channel.id)?.liveBlocker).toBeNull();
    expect(fetches.calls()).toEqual([]);
  });

  it("creates an X planning channel", async () => {
    const response = await send(
      server.t.app,
      "POST",
      `/api/workspaces/${server.workspaceId}/channels`,
      {
        cookie: server.h.cookie,
        body: { platform: "x", displayName: "X planning" },
      },
    );
    expect(response.status).toBe(201);
    expect((await response.json()) as Channel).toMatchObject({
      platform: "x",
      displayName: "X planning",
      connected: false,
      dryRun: true,
      liveBlocker: "not_connected",
    });
    expect(fetches.calls()).toEqual([]);
  });

  it("rotates an X token pair near expiry in the daily sweep and leaves fresh ones", async () => {
    const fresh = await insertXChannel(server, X_TOKEN_REFRESH_LEAD_MS + 60 * 60_000);
    const soon = await insertXChannel(server, X_TOKEN_REFRESH_LEAD_MS - 60_000);
    const next = { access: fakeCredential("access"), refresh: fakeCredential("refresh") };
    const seen: SeenRequest[] = [];
    answer(mock.agent.get(API_ORIGIN), "POST", "/2/oauth2/token", tokenReply(next), seen);

    await refreshSweep(server);

    expect(seen).toHaveLength(1);
    expect(fetches.calls()).toEqual([`${API_ORIGIN}/2/oauth2/token`]);
    const form = await formOf(seen[0]);
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("refresh_token")).toBe(soon.refreshToken);
    expect(seen[0]?.headers.authorization).toBe(
      `Basic ${Buffer.from(`${app.clientId}:${app.clientSecret}`).toString("base64")}`,
    );

    const rotated = await channelRow(server, soon.id);
    expect(rotated.secret).toMatchObject({
      accessToken: next.access,
      refreshToken: next.refresh,
      provider: "x",
    });
    expect(rotated.row.tokenExpiresAt?.getTime()).toBe(server.t.clock.now().getTime() + 7_200_000);
    expect(rotated.row.status).toBe("active");
    const untouched = await channelRow(server, fresh.id);
    expect(untouched.secret).toMatchObject({
      accessToken: fresh.accessToken,
      refreshToken: fresh.refreshToken,
    });

    const audits = await server.h.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.targetId, soon.id), eq(auditLog.action, "channel.token_refreshed")));
    expect(audits).toHaveLength(1);
    const updated = eventsOf(server.h.live, "channel.updated").filter(
      (event) => event.payload.channel.id === soon.id,
    );
    expect(updated.at(-1)?.payload.channel.tokenExpiresAt).toBe(
      rotated.row.tokenExpiresAt?.toISOString(),
    );
    const visible = [JSON.stringify(audits), JSON.stringify(server.h.live), server.t.logs.join()];
    for (const text of visible) {
      expect(text).not.toContain(next.access);
      expect(text).not.toContain(next.refresh);
    }
  });

  it("flags an X channel needs_reauth when X refuses the refresh", async () => {
    const channel = await insertXChannel(server, -60_000);
    answer(mock.agent.get(API_ORIGIN), "POST", "/2/oauth2/token", {
      status: 400,
      body: {
        error: "invalid_grant",
        error_description: "Value passed for the token was invalid.",
      },
    });
    await refreshSweep(server, channel.id);
    const { row, secret } = await channelRow(server, channel.id);
    expect(row.status).toBe("needs_reauth");
    expect(row.lastError).toMatchObject({ code: "auth", retryable: false });
    expect(secret).toMatchObject({
      accessToken: channel.accessToken,
      refreshToken: channel.refreshToken,
    });
  });

  it("routes a live X post to the X adapter", async () => {
    const channel = await insertXChannel(server, 60 * 60_000);
    const { postId, bytes } = await livePost(server, channel.id);
    const mediaId = fakeId();
    const tweetId = "1846000000000000001";
    const pool = mock.agent.get(API_ORIGIN);
    const seen: SeenRequest[] = [];
    answer(
      pool,
      "POST",
      "/2/media/upload/initialize",
      { body: { data: { id: mediaId, media_key: `7_${mediaId}` } } },
      seen,
    );
    answer(pool, "POST", `/2/media/upload/${mediaId}/append`, { body: {} }, seen);
    answer(
      pool,
      "POST",
      `/2/media/upload/${mediaId}/finalize`,
      { body: { data: { id: mediaId } } },
      seen,
    );
    answer(pool, "POST", "/2/tweets", { status: 201, body: { data: { id: tweetId } } }, seen);

    await enqueuePublish(server.deps.scheduler, postId, server.t.clock.now());
    await runDue(server.deps.scheduler);

    expect(seen.map((request) => request.path)).toEqual([
      "/2/media/upload/initialize",
      `/2/media/upload/${mediaId}/append`,
      `/2/media/upload/${mediaId}/finalize`,
      "/2/tweets",
    ]);
    for (const request of seen) {
      expect(request.headers.authorization).toBe(`Bearer ${channel.accessToken}`);
    }
    // The render streamed from the bucket is what was appended, and the post carries its id.
    expect((await bodyOf(seen[1])).includes(bytes)).toBe(true);
    expect(JSON.parse((await bodyOf(seen[3])).toString("utf8"))).toMatchObject({
      media: { media_ids: [mediaId] },
    });

    const post = await postRow(server, postId);
    expect(post).toMatchObject({
      status: "published",
      externalId: tweetId,
      permalink: `https://x.com/loomcast/status/${tweetId}`,
    });
    const [attempt] = await server.h.db
      .select()
      .from(publishAttempts)
      .where(eq(publishAttempts.postId, postId));
    expect(attempt).toMatchObject({ adapter: "x", dryRun: false, error: null });
    const stored = JSON.stringify(attempt);
    expect(stored).not.toContain(channel.accessToken);
    expect(stored).not.toContain(channel.refreshToken);
  });
});
