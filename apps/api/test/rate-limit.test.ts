import type { JsonObject, Platform } from "@loomcast/contracts";
import { channels, scheduledPosts, scheduledTasks } from "@loomcast/db";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { parseUsageHeaders, usageSnapshot } from "../src/lib/meta-graph";
import { contentServiceFor } from "../src/modules/content";
import { enqueueInsightsPulls, insightsDedupeKey } from "../src/modules/insights";
import {
  type AdapterRegistry,
  createUsageObserver,
  META_USAGE_WINDOW_MS,
  type PublisherAdapter,
  PublishFailure,
  type PublishResult,
  RATE_LIMITED_FALLBACK_MS,
  rateLimitedRetryMs,
  recordChannelUsage,
  registerPublisherTasks,
  type StatusResult,
  throttleOf,
  type UsageObserver,
} from "../src/modules/publisher";
import { createScheduler, type Scheduler } from "../src/modules/scheduler";
import {
  createPipelineHarness,
  insertItem,
  insertWorkspace,
  type PipelineHarness,
} from "./pipeline-support";
import { appWith, insertChannel, insertPost, runDue, testKeyring } from "./publisher-support";

// Throttling from the platforms' usage reports. Header fixtures are parsed the way the Graph client
// parses them; every platform call is a scripted `fetch` or a fake adapter, so nothing leaves the
// process.

const NOW = new Date("2026-10-13T12:00:00.000Z");
const MINUTE = 60_000;

function ago(ms: number): string {
  return new Date(NOW.getTime() - ms).toISOString();
}

function inFuture(ms: number): string {
  return new Date(NOW.getTime() + ms).toISOString();
}

/** A Graph response's headers with the given usage reports. */
function usageHeaders(app?: JsonObject, business?: JsonObject): Headers {
  const headers = new Headers({ "content-type": "application/json" });
  if (app !== undefined) headers.set("x-app-usage", JSON.stringify(app));
  if (business !== undefined) headers.set("x-business-use-case-usage", JSON.stringify(business));
  return headers;
}

/** The channel report a call with `headers` leaves, captured `capturedAgoMs` before `NOW`. */
function reportOf(headers: Headers, capturedAgoMs = 0): JsonObject | null {
  const usage = parseUsageHeaders(headers);
  return usage === null ? null : usageSnapshot(usage, new Date(NOW.getTime() - capturedAgoMs));
}

describe("throttle decisions from header fixtures", () => {
  it("lets a channel without a report or with low usage through", () => {
    expect(throttleOf(null, NOW)).toBeNull();
    expect(throttleOf({}, NOW)).toBeNull();
    expect(reportOf(new Headers())).toBeNull();
    const low = reportOf(usageHeaders({ call_count: 12, total_cputime: 5, total_time: 80 }));
    expect(throttleOf(low, NOW)).toBeNull();
  });

  it("holds a channel above 80% app usage for the rolling hour", () => {
    const report = reportOf(
      usageHeaders({ call_count: 81, total_cputime: 3, total_time: 4 }),
      10 * MINUTE,
    );
    expect(throttleOf(report, NOW)).toEqual({
      until: new Date(NOW.getTime() - 10 * MINUTE + META_USAGE_WINDOW_MS),
      dimension: "appUsage.call_count",
    });
    // Once the window has passed the report no longer holds the channel.
    const stale = reportOf(usageHeaders({ call_count: 99 }), META_USAGE_WINDOW_MS + MINUTE);
    expect(throttleOf(stale, NOW)).toBeNull();
  });

  it("reads every business use case dimension and the time to regain access", () => {
    const busy = reportOf(
      usageHeaders(undefined, {
        "1234": [{ type: "instagram", call_count: 10, total_cputime: 92, total_time: 20 }],
      }),
    );
    expect(throttleOf(busy, NOW)).toEqual({
      until: new Date(NOW.getTime() + META_USAGE_WINDOW_MS),
      dimension: "businessUseCaseUsage.1234.total_cputime",
    });

    const blocked = reportOf(
      usageHeaders(
        { call_count: 1 },
        {
          "1234": [{ type: "pages", call_count: 100, estimated_time_to_regain_access: 90 }],
          "5678": [{ type: "pages", call_count: 2, estimated_time_to_regain_access: 0 }],
        },
      ),
    );
    expect(throttleOf(blocked, NOW)).toEqual({
      until: new Date(NOW.getTime() + 90 * MINUTE),
      dimension: "businessUseCaseUsage.1234.estimated_time_to_regain_access",
    });
  });

  it("ignores usage headers that are not JSON objects", () => {
    const headers = new Headers({ "x-app-usage": "not json", "x-business-use-case-usage": "[]" });
    expect(parseUsageHeaders(headers)).toBeNull();
  });

  it("honours blockedUntil until it passes", () => {
    expect(throttleOf({ blockedUntil: inFuture(5 * MINUTE) }, NOW)).toEqual({
      until: new Date(NOW.getTime() + 5 * MINUTE),
      dimension: "blockedUntil",
    });
    expect(throttleOf({ blockedUntil: ago(MINUTE) }, NOW)).toBeNull();
  });

  it("holds an X channel until the window that is more than 80% used resets", () => {
    const base = { platform: "x", capturedAt: ago(MINUTE) };
    expect(
      throttleOf({ ...base, limit: 100, remaining: 50, resetAt: inFuture(10 * MINUTE) }, NOW),
    ).toBeNull();
    expect(
      throttleOf({ ...base, limit: 100, remaining: 15, resetAt: inFuture(10 * MINUTE) }, NOW),
    ).toEqual({ until: new Date(NOW.getTime() + 10 * MINUTE), dimension: "remaining" });
    expect(
      throttleOf(
        {
          ...base,
          limit: 100,
          remaining: 99,
          resetAt: inFuture(MINUTE),
          userDayLimit: 17,
          userDayRemaining: 0,
          userDayResetAt: inFuture(600 * MINUTE),
        },
        NOW,
      ),
    ).toEqual({ until: new Date(NOW.getTime() + 600 * MINUTE), dimension: "userDayRemaining" });
  });

  it("backs off rate-limit errors with retryAfterMs, the report or the fallback", () => {
    expect(rateLimitedRetryMs({ retryAfterMs: 120_000 }, null, NOW)).toBe(120_000);
    expect(rateLimitedRetryMs({}, null, NOW)).toBe(RATE_LIMITED_FALLBACK_MS);
    const report = reportOf(usageHeaders({ call_count: 100 }));
    expect(rateLimitedRetryMs({ retryAfterMs: 1_000 }, report, NOW)).toBe(META_USAGE_WINDOW_MS);
  });
});

describe("usage observer", () => {
  it("keeps each run's latest report in its own scope", async () => {
    const answers = new Map<string, Headers>([
      ["/a", usageHeaders({ call_count: 10 })],
      ["/b", usageHeaders({ call_count: 90 })],
    ]);
    const observer = createUsageObserver(async (input) => {
      const path = new URL(input).pathname;
      return new Response("{}", { headers: answers.get(path) ?? new Headers() });
    });
    const first = observer.observe(async () => {
      await observer.fetch("https://graph.example.test/a", {});
      await Promise.resolve();
      return "a";
    });
    const second = observer.observe(async () => {
      await observer.fetch("https://graph.example.test/b", {});
      await observer.fetch("https://graph.example.test/none", {});
      return "b";
    });
    expect(await first.result).toBe("a");
    expect(await second.result).toBe("b");
    expect(first.scope.usage?.appUsage).toEqual({ call_count: 10 });
    expect(second.scope.usage?.appUsage).toEqual({ call_count: 90 });
    // Calls outside a scope are passed through untouched.
    await expect(observer.fetch("https://graph.example.test/a", {})).resolves.toBeInstanceOf(
      Response,
    );
  });
});

// Scheduler integration --------------------------------------------------------------------------

let h: PipelineHarness;
let workspaceId: string;
const keyring = testKeyring();

beforeAll(async () => {
  h = await createPipelineHarness();
  workspaceId = await insertWorkspace(h);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await h.db.delete(scheduledTasks);
});

afterAll(async () => {
  await h.close();
});

interface Live {
  scheduler: Scheduler;
  close(): Promise<void>;
}

/** A server publishing live through `adapter`, with the usage observer and the insights hook. */
function liveServer(adapter: PublisherAdapter, usage: UsageObserver): Live {
  const { t, deps } = appWith(h.db, {
    clock: h.t.clock,
    config: { publishing: { mode: "live", enabled: true }, encryption: keyring },
  });
  const scheduler = createScheduler({
    db: h.db,
    bus: t.bus,
    clock: h.t.clock,
    logger: deps.logger,
    config: { enabled: true, tickMs: 5_000 },
    random: () => 0.5,
  });
  const adapters = { instagram: adapter, facebook: adapter, threads: adapter, x: adapter };
  registerPublisherTasks({
    ...deps,
    scheduler,
    content: contentServiceFor(deps),
    adapters: adapters as AdapterRegistry,
    alert: () => undefined,
    usage,
    onLivePublished: async (tx, post) => {
      await enqueueInsightsPulls(scheduler, tx, post);
    },
  });
  return {
    scheduler,
    close: async () => {
      await scheduler.stop(1_000);
      await t.deps.lifecycle.close();
    },
  };
}

function fakeAdapter(
  platform: Platform,
  script: {
    publish?: PublisherAdapter["publish"];
    status?: PublisherAdapter["status"];
  },
): PublisherAdapter {
  return {
    platform,
    validate: vi.fn(async () => []),
    publish: vi.fn(
      script.publish ??
        (async (): Promise<PublishResult> => ({
          pending: false,
          permalink: "https://www.instagram.com/reel/abc/",
          externalId: "17900000000000001",
        })),
    ),
    status: vi.fn(script.status ?? (async (): Promise<StatusResult> => ({ state: "pending" }))),
  };
}

async function liveChannel(platform: Platform = "instagram") {
  return insertChannel(h.db, keyring, {
    platform,
    connected: true,
    status: "active",
    dryRun: false,
  });
}

async function queuedLivePost(channelId: string) {
  const item = await insertItem(h, { workspaceId, state: "scheduled", level: "render" });
  const postId = await insertPost(h.db, {
    itemId: item.itemId,
    versionId: item.versionId,
    channelId,
    scheduledAt: h.t.clock.now(),
    dryRun: false,
  });
  await h.deps.scheduler.enqueue(
    "post.publish",
    { postId },
    { runAt: h.t.clock.now(), dedupeKey: `publish:${postId}` },
  );
  return postId;
}

async function postRow(id: string) {
  const [row] = await h.db.select().from(scheduledPosts).where(eq(scheduledPosts.id, id));
  if (row === undefined) throw new Error("post not found");
  return row;
}

async function rateLimitOf(channelId: string) {
  const [row] = await h.db
    .select({ rateLimit: channels.rateLimit })
    .from(channels)
    .where(eq(channels.id, channelId));
  return row?.rateLimit ?? null;
}

async function pendingTasks(kind: string) {
  const rows = await h.db.select().from(scheduledTasks).where(eq(scheduledTasks.kind, kind));
  return rows.filter((row) => row.status === "pending");
}

describe("publisher throttling", () => {
  it("makes no publish call while the channel is over its usage threshold", async () => {
    const usage = createUsageObserver(async () => new Response("{}"));
    const adapter = fakeAdapter("instagram", {});
    const server = liveServer(adapter, usage);
    try {
      const channel = await liveChannel();
      const now = h.t.clock.now();
      await h.db
        .update(channels)
        .set({ rateLimit: { capturedAt: now.toISOString(), appUsage: { call_count: 95 } } })
        .where(eq(channels.id, channel.id));
      const postId = await queuedLivePost(channel.id);

      await runDue(server.scheduler);

      expect(adapter.publish).not.toHaveBeenCalled();
      const post = await postRow(postId);
      expect(post.status).toBe("queued");
      expect(post.lastError).toMatchObject({
        code: "rate_limited",
        retryAfterMs: META_USAGE_WINDOW_MS,
      });
      const [next] = await pendingTasks("post.publish");
      expect(next?.runAt).toEqual(new Date(now.getTime() + META_USAGE_WINDOW_MS));

      // Once the window has passed the post goes out and its insights are scheduled.
      h.t.clock.advance(META_USAGE_WINDOW_MS);
      await runDue(server.scheduler);
      expect(adapter.publish).toHaveBeenCalledTimes(1);
      const published = await postRow(postId);
      expect(published.status).toBe("published");
      const pulls = await pendingTasks("insights.pull");
      expect(pulls.map((task) => task.dedupeKey).sort()).toEqual(
        [0, 1, 2, 3, 4, 5, 6].map((index) => insightsDedupeKey(postId, index)).sort(),
      );
    } finally {
      await server.close();
    }
  });

  it("stores the usage headers of a live attempt and holds the next post back", async () => {
    const usage = createUsageObserver(
      async () => new Response("{}", { headers: usageHeaders({ call_count: 40, total_time: 88 }) }),
    );
    const adapter = fakeAdapter("facebook", {
      publish: async () => {
        await usage.fetch("https://graph.example.test/v26.0/123/video_reels", {});
        return { pending: false, permalink: "https://www.facebook.com/reel/1", externalId: "1" };
      },
    });
    const server = liveServer(adapter, usage);
    try {
      const channel = await liveChannel("facebook");
      const first = await queuedLivePost(channel.id);
      await runDue(server.scheduler);
      expect((await postRow(first)).status).toBe("published");
      expect(await rateLimitOf(channel.id)).toEqual({
        capturedAt: h.t.clock.now().toISOString(),
        appUsage: { call_count: 40, total_time: 88 },
        businessUseCaseUsage: null,
      });

      const second = await queuedLivePost(channel.id);
      await runDue(server.scheduler);
      expect(adapter.publish).toHaveBeenCalledTimes(1);
      expect((await postRow(second)).lastError).toMatchObject({ code: "rate_limited" });
    } finally {
      await server.close();
    }
  });

  it("backs a rate-limit failure off with retryAfterMs and blocks the channel", async () => {
    const usage = createUsageObserver(async () => new Response("{}"));
    const adapter = fakeAdapter("threads", {
      publish: async () => {
        throw PublishFailure.of("rate_limited", "Too many calls.", { retryable: true });
      },
    });
    const server = liveServer(adapter, usage);
    try {
      const channel = await liveChannel("threads");
      const postId = await queuedLivePost(channel.id);
      const now = h.t.clock.now();
      await runDue(server.scheduler);

      const post = await postRow(postId);
      expect(post.status).toBe("queued");
      expect(post.lastError).toMatchObject({
        code: "rate_limited",
        retryAfterMs: RATE_LIMITED_FALLBACK_MS,
      });
      expect(await rateLimitOf(channel.id)).toEqual({
        blockedUntil: new Date(now.getTime() + RATE_LIMITED_FALLBACK_MS).toISOString(),
      });
      const [retry] = await pendingTasks("post.publish");
      expect(retry?.runAt).toEqual(new Date(now.getTime() + RATE_LIMITED_FALLBACK_MS));
    } finally {
      await server.close();
    }
  });

  it("delays status polling while throttled and pauses its timeout", async () => {
    const usage = createUsageObserver(async () => new Response("{}"));
    const adapter = fakeAdapter("instagram", {
      publish: async () => ({ pending: true, containerId: "c-1" }),
    });
    const server = liveServer(adapter, usage);
    try {
      const channel = await liveChannel();
      const postId = await queuedLivePost(channel.id);
      await runDue(server.scheduler);
      const [poll] = await pendingTasks("post.check_status");
      expect(poll).toBeDefined();

      const blockedUntil = new Date(h.t.clock.now().getTime() + 30 * MINUTE);
      await recordChannelUsage(h.db, channel.id, { blockedUntil, at: h.t.clock.now() });
      h.t.clock.advance(60_000);
      await runDue(server.scheduler);

      expect(adapter.status).not.toHaveBeenCalled();
      const [next] = await pendingTasks("post.check_status");
      expect(next?.runAt).toEqual(blockedUntil);
      const since = Date.parse(String((poll?.payload as JsonObject | undefined)?.since));
      expect(Date.parse(String((next?.payload as JsonObject | undefined)?.since))).toBe(
        since + (blockedUntil.getTime() - h.t.clock.now().getTime()),
      );
      expect((await postRow(postId)).status).toBe("publishing");
    } finally {
      await server.close();
    }
  });

  it("merges usage into the report and keeps other keys", async () => {
    const channel = await liveChannel("x");
    await h.db
      .update(channels)
      .set({ rateLimit: { platform: "x", remaining: 5, businessUseCaseUsage: { old: [] } } })
      .where(eq(channels.id, channel.id));
    const usage = parseUsageHeaders(usageHeaders({ call_count: 3 }));
    await recordChannelUsage(h.db, channel.id, { usage, at: NOW });
    expect(await rateLimitOf(channel.id)).toEqual({
      platform: "x",
      remaining: 5,
      capturedAt: NOW.toISOString(),
      appUsage: { call_count: 3 },
      businessUseCaseUsage: null,
    });
    await recordChannelUsage(h.db, channel.id, { usage: null, at: NOW });
    expect(await rateLimitOf(channel.id)).toMatchObject({ remaining: 5 });
  });
});
