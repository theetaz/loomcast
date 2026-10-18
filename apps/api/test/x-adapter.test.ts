import { randomBytes, randomUUID } from "node:crypto";
import type { JsonObject } from "@loomcast/contracts";
import { auditLog, channels, type Database } from "@loomcast/db";
import { createTestDb, type TestDb } from "@loomcast/db/testing";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { parseConfig, type XAppConfig } from "../src/env";
import { createLogger } from "../src/lib/logger";
import { channelAad, createVault, sealedSecretOf, type TokenVault } from "../src/lib/vault";
import { publisherAdapters } from "../src/modules/publisher";
import {
  classifyXError,
  createXAdapter,
  createXClient,
  freshXAccessToken,
  parseXRateLimit,
  segmentsOf,
  X_TOKEN_REFRESH_LEAD_MS,
  xAdapter,
  xPermalink,
  xRetryAfterMs,
} from "../src/modules/publisher/adapters/x";
import { PublishFailure } from "../src/modules/publisher/errors";
import type { PublishContext, PublishMedia } from "../src/modules/publisher/types";
import { fakeCredential, fakeId } from "./oauth-support";
import { testKeyring } from "./publisher-support";

// The X adapter against a fake `fetch`: nothing here opens a connection. Tokens, client secrets
// and ids are generated per run.

const API = "https://api.x.com";
const MB = 1_048_576;

interface Call {
  method: string;
  url: URL;
  headers: Headers;
  body: unknown;
}

interface Route {
  method: string;
  path: string | RegExp;
  reply: (call: Call) => { status?: number; body?: unknown; headers?: Record<string, string> };
}

/** A fake `fetch` that answers the routes in order of declaration and records every call. */
function fakeX(routes: Route[] = []) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (input: string, init: RequestInit) => {
    const url = new URL(input);
    const call: Call = {
      method: String(init.method ?? "GET"),
      url,
      headers: new Headers(init.headers),
      body: init.body,
    };
    calls.push(call);
    const route = routes.find(
      (candidate) =>
        candidate.method === call.method &&
        (typeof candidate.path === "string"
          ? candidate.path === url.pathname
          : candidate.path.test(url.pathname)),
    );
    if (route === undefined) {
      throw new Error(`no fake answer for ${call.method} ${url.pathname}`);
    }
    const reply = route.reply(call);
    return new Response(reply.body === undefined ? "" : JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { "content-type": "application/json", ...(reply.headers ?? {}) },
    });
  });
  return { fetch, calls };
}

function fakeApp(): XAppConfig {
  return { clientId: fakeCredential("client"), clientSecret: fakeCredential("client-secret") };
}

const logger = createLogger({ level: "silent", destination: { write: () => undefined } });

function media(bytes: number): PublishMedia {
  return {
    format: "reel",
    video: {
      assetId: randomUUID(),
      sha256: randomBytes(32).toString("hex"),
      durationMs: 30_000,
      width: 1_080,
      height: 1_920,
      bytes,
      mime: "video/mp4",
    },
    items: [],
    posterAssetId: null,
  };
}

/** A context whose storage, credentials and public URLs fail the test if anything reads them. */
function contextFor(input: {
  channelId: string;
  dryRun?: boolean;
  bytes?: number;
  externalId?: string | null;
  externalContainerId?: string | null;
  postExternalId?: string | null;
  username?: string | null;
  now?: () => Date;
}): { context: PublishContext; recorded: { request?: JsonObject; response?: JsonObject }[] } {
  const recorded: { request?: JsonObject; response?: JsonObject }[] = [];
  const forbidden = (what: string) => () => {
    throw new Error(`the X adapter must not call ${what}`);
  };
  const context: PublishContext = {
    platform: "x",
    dryRun: input.dryRun ?? false,
    post: {
      id: randomUUID(),
      itemId: randomUUID(),
      versionId: randomUUID(),
      scheduledAt: new Date(),
      attempt: 1,
      attemptStartedAt: new Date(),
      externalId: input.postExternalId ?? null,
      externalContainerId: input.externalContainerId ?? null,
    },
    channel: {
      id: input.channelId,
      platform: "x",
      displayName: "X channel",
      externalId: input.externalId === undefined ? fakeId() : input.externalId,
      username: input.username === undefined ? "loomcast" : input.username,
      parentChannelId: null,
      scopes: [],
      meta: {},
    },
    media: media(input.bytes ?? 9 * MB + 123),
    secrets: vi.fn(forbidden("secrets")),
    getPublicVideoUrl: vi.fn(forbidden("getPublicVideoUrl")),
    getPublicPosterUrl: vi.fn(forbidden("getPublicPosterUrl")),
    caption: () => ({ text: "A short video about queues #loomcast", issues: [], truncated: false }),
    publishRequest: vi.fn(forbidden("publishRequest")),
    record: (part: { request?: JsonObject; response?: JsonObject }) => {
      recorded.push(part);
    },
    signal: new AbortController().signal,
    logger,
    now: input.now ?? (() => new Date()),
  } as unknown as PublishContext;
  return { context, recorded };
}

/** Bytes delivered in uneven chunks, the way an object store stream arrives. */
function streamOf(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  return (async function* () {
    let offset = 0;
    let size = 777_777;
    while (offset < bytes.length) {
      yield bytes.subarray(offset, offset + size);
      offset += size;
      size = size * 3 + 1;
    }
  })();
}

describe("x rate limits and errors", () => {
  it("reads the endpoint and daily rate-limit headers", () => {
    const reset = Math.floor(Date.now() / 1000) + 600;
    const rate = parseXRateLimit(
      new Headers({
        "x-rate-limit-limit": "100",
        "x-rate-limit-remaining": "0",
        "x-rate-limit-reset": String(reset),
        "x-user-limit-24hour-limit": "17",
        "x-user-limit-24hour-remaining": "5",
        "x-user-limit-24hour-reset": String(reset + 3_600),
      }),
    );
    expect(rate).toEqual({
      limit: 100,
      remaining: 0,
      resetAt: new Date(reset * 1000).toISOString(),
      userDayLimit: 17,
      userDayRemaining: 5,
      userDayResetAt: new Date((reset + 3_600) * 1000).toISOString(),
    });
    expect(parseXRateLimit(new Headers())).toBeNull();
  });

  it("waits until the exhausted window resets", () => {
    const now = new Date("2026-10-13T10:00:00Z");
    const rate = {
      limit: 100,
      remaining: 3,
      resetAt: "2026-10-13T10:05:00.000Z",
      userDayLimit: 17,
      userDayRemaining: 0,
      userDayResetAt: "2026-10-13T20:00:00.000Z",
    };
    expect(xRetryAfterMs(rate, now)).toBe(10 * 60 * 60_000);
    expect(xRetryAfterMs({ ...rate, userDayRemaining: 4 }, now)).toBe(5 * 60_000);
    expect(xRetryAfterMs(null, now)).toBe(15 * 60_000);
  });

  it("classifies X failures onto publish error codes", () => {
    const now = new Date();
    const code = (status: number | null, body: unknown) =>
      classifyXError(status, body, null, now).error.code;
    expect(code(401, { title: "Unauthorized", detail: "Unauthorized" })).toBe("auth");
    expect(code(400, { error: "invalid_grant", error_description: "Value passed" })).toBe("auth");
    expect(code(429, { title: "Too Many Requests" })).toBe("rate_limited");
    expect(
      code(403, { detail: "You are not allowed to create a Tweet with duplicate content." }),
    ).toBe("permanent");
    expect(
      code(403, { detail: "This user is not allowed to post a video longer than 2 minutes" }),
    ).toBe("invalid_media");
    expect(code(403, { detail: "Forbidden" })).toBe("permission");
    expect(code(503, {})).toBe("transient");
    expect(code(null, {})).toBe("transient");
    expect(code(400, { errors: [{ message: "Invalid Request" }] })).toBe("permanent");
  });

  it("never puts a URL from the platform into the error message", () => {
    const { error } = classifyXError(
      400,
      { detail: "see https://api.x.com/2/tweets?token=abc for details" },
      null,
      new Date(),
    );
    expect(error.message).not.toContain("https://");
    expect(error.message).not.toContain("token=");
  });

  it("retries a failed GET but never repeats a POST", async () => {
    let gets = 0;
    let posts = 0;
    const { fetch } = fakeX([
      {
        method: "GET",
        path: "/2/users/me",
        reply: () => (++gets < 3 ? { status: 503 } : { body: {} }),
      },
      {
        method: "POST",
        path: "/2/tweets",
        reply: () => {
          posts += 1;
          return { status: 503 };
        },
      },
    ]);
    const client = createXClient({ baseUrl: API, fetch, sleep: async () => undefined });
    await client.request({ path: "/2/users/me" });
    expect(gets).toBe(3);
    await expect(
      client.request({ method: "POST", path: "/2/tweets", json: {} }),
    ).rejects.toMatchObject({
      error: { code: "transient" },
    });
    expect(posts).toBe(1);
  });
});

describe("x chunking", () => {
  it("cuts a stream into exact 4 MB segments", async () => {
    const bytes = randomBytes(9 * MB + 123);
    const segments: Uint8Array[] = [];
    for await (const segment of segmentsOf(streamOf(bytes))) {
      segments.push(Uint8Array.from(segment));
    }
    expect(segments.map((segment) => segment.length)).toEqual([4 * MB, 4 * MB, MB + 123]);
    expect(Buffer.concat(segments).equals(bytes)).toBe(true);
  });

  it("yields nothing for an empty stream and one short segment for a small one", async () => {
    const collect = async (source: AsyncIterable<Uint8Array>, size?: number) => {
      const out: number[] = [];
      for await (const segment of segmentsOf(source, size)) {
        out.push(segment.length);
      }
      return out;
    };
    expect(await collect(streamOf(new Uint8Array(0)))).toEqual([]);
    expect(await collect(streamOf(randomBytes(10)), 4)).toEqual([4, 4, 2]);
  });
});

describe("x feature flag off", () => {
  it("parses FEATURE_X_PUBLISHING as off by default", () => {
    const base = {
      DATABASE_URL: "postgres://loomcast@127.0.0.1:5432/loomcast",
      APP_ORIGIN: "http://localhost:5173",
      PUBLIC_BASE_URL: "http://127.0.0.1:59000/loomcast-public",
    };
    const off = parseConfig(base).platforms;
    expect(off.xPublishing ?? false).toBe(false);
    expect(off.x ?? null).toBeNull();
    expect(parseConfig({ ...base, FEATURE_X_PUBLISHING: "" }).platforms.xPublishing ?? false).toBe(
      false,
    );
    expect(
      parseConfig({ ...base, FEATURE_X_PUBLISHING: "false" }).platforms.xPublishing ?? false,
    ).toBe(false);
    const clientId = fakeCredential("client");
    const on = parseConfig({
      ...base,
      FEATURE_X_PUBLISHING: "true",
      X_CLIENT_ID: clientId,
      X_CLIENT_SECRET: fakeCredential("secret"),
    }).platforms;
    expect(on.xPublishing).toBe(true);
    expect(on.x?.clientId).toBe(clientId);
    expect(() => parseConfig({ ...base, X_CLIENT_ID: clientId })).toThrow(/X_CLIENT_SECRET/);
  });

  it("refuses every call with not_configured and sends nothing to X", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const { fetch, calls } = fakeX();
    const open = vi.fn(async () => streamOf(randomBytes(16)));
    const tokens = { db: {} as Database, vault: {} as TokenVault };
    const adapters = [
      // The registry's default adapter.
      xAdapter,
      publisherAdapters.x,
      // Fully wired, with an X app, but the flag is off.
      createXAdapter({
        platforms: { xPublishing: false, x: fakeApp() },
        tokens,
        media: open,
        fetch,
      }),
      // Flag on without an X app.
      createXAdapter({ platforms: { xPublishing: true, x: null }, tokens, media: open, fetch }),
      // Settings from before X existed.
      createXAdapter({ platforms: {}, tokens, media: open, fetch }),
    ];
    try {
      for (const adapter of adapters) {
        const { context, recorded } = contextFor({
          channelId: randomUUID(),
          externalContainerId: fakeId(),
        });
        for (const call of [
          () => adapter.validate(context),
          () => adapter.publish(context),
          () => adapter.status(context),
        ]) {
          const failure = await call().then(
            () => null,
            (error: unknown) => error,
          );
          expect(failure).toBeInstanceOf(PublishFailure);
          expect((failure as PublishFailure).error).toMatchObject({
            code: "not_configured",
            retryable: false,
          });
        }
        expect(recorded).toEqual([]);
        expect(context.secrets).not.toHaveBeenCalled();
        expect(context.getPublicVideoUrl).not.toHaveBeenCalled();
        expect(context.publishRequest).not.toHaveBeenCalled();
      }
      expect(open).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      expect(calls).toEqual([]);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("x adapter", () => {
  let testDb: TestDb;
  let db: Database;
  let vault: TokenVault;
  const app = fakeApp();

  beforeAll(async () => {
    testDb = await createTestDb();
    db = testDb.db;
    vault = createVault(testKeyring());
  });

  afterAll(async () => {
    await testDb.drop();
  });

  async function insertXChannel(expiresInMs: number) {
    const id = randomUUID();
    const accessToken = fakeCredential("access");
    const refreshToken = fakeCredential("refresh");
    const sealed = vault.encrypt({ accessToken, refreshToken, provider: "x" }, channelAad(id));
    const externalId = fakeId();
    await db.insert(channels).values({
      id,
      platform: "x",
      displayName: "X channel",
      externalId,
      username: "loomcast",
      status: "active",
      dryRun: false,
      ...sealed,
      tokenExpiresAt: new Date(Date.now() + expiresInMs),
    });
    return { id, accessToken, refreshToken, externalId };
  }

  async function storedSecret(id: string) {
    const [row] = await db.select().from(channels).where(eq(channels.id, id));
    const sealed = row === undefined ? null : sealedSecretOf(row);
    if (row === undefined || sealed === null) {
      throw new Error("no credentials");
    }
    return { row, secret: vault.decrypt(sealed, channelAad(id)) };
  }

  function tokenRoute(pairs: { access: string; refresh: string }[], seen: Call[]): Route {
    let index = 0;
    return {
      method: "POST",
      path: "/2/oauth2/token",
      reply: (call) => {
        seen.push(call);
        const pair = pairs[index++];
        if (pair === undefined) {
          return { status: 400, body: { error: "invalid_grant", error_description: "spent" } };
        }
        return {
          body: {
            token_type: "bearer",
            access_token: pair.access,
            refresh_token: pair.refresh,
            expires_in: 7_200,
            scope: "tweet.read tweet.write users.read media.write offline.access",
          },
        };
      },
    };
  }

  describe("token rotation", () => {
    it("keeps a token with more than 10 minutes left without calling X", async () => {
      const channel = await insertXChannel(X_TOKEN_REFRESH_LEAD_MS + 60_000);
      const { fetch } = fakeX();
      const fresh = await freshXAccessToken(
        { db, vault },
        {
          client: createXClient({ baseUrl: API, fetch }),
          app,
          channelId: channel.id,
          now: new Date(),
        },
      );
      expect(fresh).toMatchObject({ accessToken: channel.accessToken, refreshed: false });
      expect(fetch).not.toHaveBeenCalled();
    });

    it("rotates a pair with less than 10 minutes left and stores the new pair at once", async () => {
      const channel = await insertXChannel(X_TOKEN_REFRESH_LEAD_MS - 60_000);
      const next = { access: fakeCredential("access"), refresh: fakeCredential("refresh") };
      const seen: Call[] = [];
      const { fetch } = fakeX([tokenRoute([next], seen)]);
      const now = new Date();
      const fresh = await freshXAccessToken(
        { db, vault },
        { client: createXClient({ baseUrl: API, fetch }), app, channelId: channel.id, now },
      );
      expect(fresh).toMatchObject({ accessToken: next.access, refreshed: true });

      const [call] = seen;
      const form = new URLSearchParams(String(call?.body));
      expect(form.get("grant_type")).toBe("refresh_token");
      expect(form.get("refresh_token")).toBe(channel.refreshToken);
      expect(call?.headers.get("authorization")).toBe(
        `Basic ${Buffer.from(`${app.clientId}:${app.clientSecret}`).toString("base64")}`,
      );

      const { row, secret } = await storedSecret(channel.id);
      expect(secret).toMatchObject({
        accessToken: next.access,
        refreshToken: next.refresh,
        provider: "x",
      });
      expect(row.tokenExpiresAt?.getTime()).toBe(now.getTime() + 7_200_000);
      expect(row.scopes).toContain("media.write");
      const audits = await db
        .select()
        .from(auditLog)
        .where(
          and(eq(auditLog.targetId, channel.id), eq(auditLog.action, "channel.token_refreshed")),
        );
      expect(audits).toHaveLength(1);
      expect(JSON.stringify(audits)).not.toContain(next.access);
      expect(JSON.stringify(audits)).not.toContain(next.refresh);
    });

    it("spends each refresh token once when two refreshes race", async () => {
      const channel = await insertXChannel(60_000);
      const next = { access: fakeCredential("access"), refresh: fakeCredential("refresh") };
      const seen: Call[] = [];
      const { fetch } = fakeX([tokenRoute([next], seen)]);
      const client = createXClient({ baseUrl: API, fetch });
      const run = () =>
        freshXAccessToken({ db, vault }, { client, app, channelId: channel.id, now: new Date() });
      const [a, b] = await Promise.all([run(), run()]);
      expect(seen).toHaveLength(1);
      expect([a.accessToken, b.accessToken]).toEqual([next.access, next.access]);
      expect([a.refreshed, b.refreshed].sort()).toEqual([false, true]);
    });

    it("keeps the stored pair when X refuses the refresh", async () => {
      const channel = await insertXChannel(60_000);
      const { fetch } = fakeX([tokenRoute([], [])]);
      await expect(
        freshXAccessToken(
          { db, vault },
          {
            client: createXClient({ baseUrl: API, fetch }),
            app,
            channelId: channel.id,
            now: new Date(),
          },
        ),
      ).rejects.toMatchObject({ error: { code: "auth" } });
      const { secret } = await storedSecret(channel.id);
      expect(secret).toMatchObject({
        accessToken: channel.accessToken,
        refreshToken: channel.refreshToken,
      });
    });

    it("flags the channel when the adapter's refresh is refused", async () => {
      const channel = await insertXChannel(60_000);
      const { fetch } = fakeX([tokenRoute([], [])]);
      const refused = vi.fn(async () => undefined);
      const adapter = createXAdapter({
        platforms: { xPublishing: true, x: app, xApiBaseUrl: API },
        tokens: { db, vault },
        media: async () => streamOf(new Uint8Array(0)),
        fetch,
        onCredentialsRefused: refused,
      });
      const { context } = contextFor({ channelId: channel.id, externalId: channel.externalId });
      await expect(adapter.publish(context)).rejects.toMatchObject({
        error: { code: "auth", retryable: false },
      });
      expect(refused).toHaveBeenCalledWith(
        expect.objectContaining({ channelId: channel.id, reason: "refresh_refused" }),
      );
    });
  });

  describe("upload and post", () => {
    /** The upload routes; `processing` is what finalize and the status polls report, in order. */
    function uploadRoutes(input: {
      mediaId: string;
      finalize: unknown;
      statuses?: unknown[];
      post?: (call: Call) => { status?: number; body?: unknown; headers?: Record<string, string> };
    }): Route[] {
      const statuses = [...(input.statuses ?? [])];
      return [
        {
          method: "POST",
          path: "/2/media/upload/initialize",
          reply: () => ({ body: { data: { id: input.mediaId, media_key: `7_${input.mediaId}` } } }),
        },
        {
          method: "POST",
          path: `/2/media/upload/${input.mediaId}/append`,
          reply: () => ({ body: null }),
        },
        {
          method: "POST",
          path: `/2/media/upload/${input.mediaId}/finalize`,
          reply: () => ({
            body: { data: { id: input.mediaId, ...((input.finalize as object) ?? {}) } },
          }),
        },
        {
          method: "GET",
          path: "/2/media/upload",
          reply: () => ({
            body: { data: { id: input.mediaId, ...((statuses.shift() as object) ?? {}) } },
          }),
        },
        {
          method: "POST",
          path: "/2/tweets",
          reply:
            input.post ?? (() => ({ status: 201, body: { data: { id: "1846000000000000001" } } })),
        },
      ];
    }

    async function appendsOf(calls: Call[]) {
      const out: { index: number; bytes: Buffer; auth: string | null }[] = [];
      for (const call of calls.filter((c) => c.url.pathname.endsWith("/append"))) {
        const form = call.body as FormData;
        const blob = form.get("media") as Blob;
        out.push({
          index: Number(form.get("segment_index")),
          bytes: Buffer.from(await blob.arrayBuffer()),
          auth: call.headers.get("authorization"),
        });
      }
      return out;
    }

    it("streams 4 MB appends, polls processing, then posts with the media id", async () => {
      const channel = await insertXChannel(60 * 60_000);
      const mediaId = fakeId();
      const bytes = randomBytes(9 * MB + 123);
      const { fetch, calls } = fakeX(
        uploadRoutes({
          mediaId,
          finalize: { processing_info: { state: "pending", check_after_secs: 1 } },
          statuses: [
            { processing_info: { state: "in_progress", progress_percent: 40 } },
            { processing_info: { state: "succeeded", progress_percent: 100 } },
          ],
        }),
      );
      const open = vi.fn(async () => streamOf(bytes));
      const adapter = createXAdapter({
        platforms: { xPublishing: true, x: app, xApiBaseUrl: API },
        tokens: { db, vault },
        media: open,
        fetch,
      });
      const { context, recorded } = contextFor({
        channelId: channel.id,
        externalId: channel.externalId,
        bytes: bytes.length,
      });

      expect(await adapter.validate(context)).toEqual([]);
      const result = await adapter.publish(context);
      expect(result).toEqual({ pending: true, containerId: mediaId });
      expect(open).toHaveBeenCalledTimes(1);

      const init = calls[0];
      expect(init?.url.pathname).toBe("/2/media/upload/initialize");
      expect(JSON.parse(String(init?.body))).toEqual({
        media_type: "video/mp4",
        total_bytes: bytes.length,
        media_category: "tweet_video",
      });
      const appends = await appendsOf(calls);
      expect(appends.map((a) => [a.index, a.bytes.length])).toEqual([
        [0, 4 * MB],
        [1, 4 * MB],
        [2, MB + 123],
      ]);
      expect(Buffer.concat(appends.map((a) => a.bytes)).equals(bytes)).toBe(true);
      expect(appends.every((a) => a.auth === `Bearer ${channel.accessToken}`)).toBe(true);
      expect(calls.at(-1)?.url.pathname).toBe(`/2/media/upload/${mediaId}/finalize`);
      expect(calls.some((c) => c.url.pathname === "/2/tweets")).toBe(false);

      // The record matches the dry-run plan and holds no token.
      const plan = recorded[0]?.request as { steps: { step: string }[] };
      expect(plan.steps.map((s) => s.step)).toEqual([
        "initialize",
        "append",
        "append",
        "append",
        "finalize",
      ]);
      expect(JSON.stringify(recorded)).not.toContain(channel.accessToken);

      const pending = contextFor({
        channelId: channel.id,
        externalId: channel.externalId,
        externalContainerId: mediaId,
      });
      expect(await adapter.status(pending.context)).toEqual({ state: "pending" });
      const status = calls.at(-1);
      expect(status?.url.searchParams.get("command")).toBe("STATUS");
      expect(status?.url.searchParams.get("media_id")).toBe(mediaId);

      const done = await adapter.status(pending.context);
      expect(done).toEqual({
        state: "published",
        externalId: "1846000000000000001",
        permalink: "https://x.com/loomcast/status/1846000000000000001",
      });
      const post = calls.at(-1);
      expect(post?.url.pathname).toBe("/2/tweets");
      expect(JSON.parse(String(post?.body))).toEqual({
        text: "A short video about queues #loomcast",
        media: { media_ids: [mediaId] },
      });
    });

    it("posts at once when X needs no processing", async () => {
      const channel = await insertXChannel(60 * 60_000);
      const mediaId = fakeId();
      const bytes = randomBytes(1_000);
      const { fetch, calls } = fakeX(uploadRoutes({ mediaId, finalize: {} }));
      const adapter = createXAdapter({
        platforms: { xPublishing: true, x: app, xApiBaseUrl: API },
        tokens: { db, vault },
        media: async () => streamOf(bytes),
        fetch,
      });
      const { context } = contextFor({
        channelId: channel.id,
        externalId: channel.externalId,
        bytes: bytes.length,
        username: null,
      });
      expect(await adapter.publish(context)).toEqual({
        pending: false,
        externalId: "1846000000000000001",
        permalink: "https://x.com/i/web/status/1846000000000000001",
      });
      expect(calls.map((c) => c.url.pathname)).toEqual([
        "/2/media/upload/initialize",
        `/2/media/upload/${mediaId}/append`,
        `/2/media/upload/${mediaId}/finalize`,
        "/2/tweets",
      ]);
    });

    it("refreshes an expiring token before uploading", async () => {
      const channel = await insertXChannel(60_000);
      const mediaId = fakeId();
      const bytes = randomBytes(2_000);
      const next = { access: fakeCredential("access"), refresh: fakeCredential("refresh") };
      const { fetch, calls } = fakeX([
        tokenRoute([next], []),
        ...uploadRoutes({ mediaId, finalize: {} }),
      ]);
      const adapter = createXAdapter({
        platforms: { xPublishing: true, x: app, xApiBaseUrl: API },
        tokens: { db, vault },
        media: async () => streamOf(bytes),
        fetch,
      });
      const { context } = contextFor({
        channelId: channel.id,
        externalId: channel.externalId,
        bytes: bytes.length,
      });
      await adapter.publish(context);
      expect(calls[0]?.url.pathname).toBe("/2/oauth2/token");
      expect(
        calls.slice(1).every((c) => c.headers.get("authorization") === `Bearer ${next.access}`),
      ).toBe(true);
    });

    it("fails a video X could not process", async () => {
      const channel = await insertXChannel(60 * 60_000);
      const mediaId = fakeId();
      const { fetch } = fakeX(
        uploadRoutes({
          mediaId,
          finalize: {},
          statuses: [
            {
              processing_info: {
                state: "failed",
                error: { code: 1, message: "Unsupported codec" },
              },
            },
          ],
        }),
      );
      const adapter = createXAdapter({
        platforms: { xPublishing: true, x: app, xApiBaseUrl: API },
        tokens: { db, vault },
        media: async () => streamOf(new Uint8Array(0)),
        fetch,
      });
      const { context } = contextFor({
        channelId: channel.id,
        externalId: channel.externalId,
        externalContainerId: mediaId,
      });
      const status = await adapter.status(context);
      expect(status.state).toBe("failed");
      expect(status.error).toMatchObject({ code: "invalid_media", retryable: false });
      expect(status.error?.message).toContain("Unsupported codec");
    });

    it("refuses a stream shorter than the recorded size before finalizing", async () => {
      const channel = await insertXChannel(60 * 60_000);
      const mediaId = fakeId();
      const bytes = randomBytes(5 * MB);
      const { fetch, calls } = fakeX(uploadRoutes({ mediaId, finalize: {} }));
      const adapter = createXAdapter({
        platforms: { xPublishing: true, x: app, xApiBaseUrl: API },
        tokens: { db, vault },
        media: async () => streamOf(bytes.subarray(0, 3 * MB)),
        fetch,
      });
      const { context } = contextFor({
        channelId: channel.id,
        externalId: channel.externalId,
        bytes: bytes.length,
      });
      await expect(adapter.publish(context)).rejects.toMatchObject({
        error: { code: "transient" },
      });
      expect(calls.some((c) => c.url.pathname.endsWith("/finalize"))).toBe(false);
    });

    it("waits out a 429 until the rate limit resets and keeps the headers on the channel", async () => {
      const channel = await insertXChannel(60 * 60_000);
      const mediaId = fakeId();
      const bytes = randomBytes(100);
      const now = new Date();
      const reset = Math.floor(now.getTime() / 1000) + 900;
      const { fetch } = fakeX(
        uploadRoutes({
          mediaId,
          finalize: {},
          post: () => ({
            status: 429,
            body: { title: "Too Many Requests", detail: "Too Many Requests", status: 429 },
            headers: {
              "x-rate-limit-limit": "100",
              "x-rate-limit-remaining": "0",
              "x-rate-limit-reset": String(reset),
            },
          }),
        }),
      );
      const adapter = createXAdapter({
        platforms: { xPublishing: true, x: app, xApiBaseUrl: API },
        tokens: { db, vault },
        media: async () => streamOf(bytes),
        fetch,
      });
      const { context } = contextFor({
        channelId: channel.id,
        externalId: channel.externalId,
        bytes: bytes.length,
        now: () => now,
      });
      const failure = await adapter.publish(context).then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(PublishFailure);
      const error = (failure as PublishFailure).error;
      expect(error).toMatchObject({
        code: "rate_limited",
        retryable: true,
        platformCode: "http_429",
      });
      expect(Math.abs((error.retryAfterMs ?? 0) - (reset * 1000 - now.getTime()))).toBeLessThan(
        1_000,
      );

      const [row] = await db.select().from(channels).where(eq(channels.id, channel.id));
      expect(row?.rateLimit).toMatchObject({
        platform: "x",
        step: "create_post",
        limit: 100,
        remaining: 0,
        resetAt: new Date(reset * 1000).toISOString(),
      });
    });

    it("validates duration, size and the weighted text length", async () => {
      const adapter = createXAdapter({
        platforms: { xPublishing: true, x: app, xApiBaseUrl: API },
      });
      const { context } = contextFor({ channelId: randomUUID(), bytes: 600 * MB });
      const long = {
        ...context,
        media: {
          ...context.media,
          video: { ...context.media.video, durationMs: 200_000 },
        },
        caption: () => ({ text: "界".repeat(141), issues: [], truncated: false }),
      } as unknown as PublishContext;
      const fields = (await adapter.validate(long)).map((issue) => issue.field).sort();
      expect(fields).toEqual(["caption", "duration", "size"]);
    });
  });

  it("builds the permalink from the handle", () => {
    expect(xPermalink("@loomcast", "1")).toBe("https://x.com/loomcast/status/1");
    expect(xPermalink("not a handle", "1")).toBe("https://x.com/i/web/status/1");
  });
});
