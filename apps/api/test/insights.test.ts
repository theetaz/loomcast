import { INSIGHTS_SCHEDULE_OFFSETS_MS, type JsonObject, type Platform } from "@loomcast/contracts";
import { channels, postMetrics, scheduledPosts, scheduledTasks } from "@loomcast/db";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { transaction } from "../src/lib/db";
import { appSecretProof } from "../src/lib/meta-graph";
import {
  enqueueInsightsPulls,
  FACEBOOK_REELS_INSIGHTS_METRICS,
  INSTAGRAM_INSIGHTS_METRICS,
  insightsDedupeKey,
  insightsRequest,
  normalizeInsights,
  registerInsightsTasks,
  stripCredentials,
  THREADS_INSIGHTS_METRICS,
} from "../src/modules/insights";
import { createScheduler, type Scheduler } from "../src/modules/scheduler";
import { THREADS_API_ORIGIN, testPlatforms } from "./meta-publisher-support";
import { fakeCredential, GRAPH_ORIGIN, GRAPH_VERSION } from "./oauth-support";
import {
  createPipelineHarness,
  eventsOf,
  insertItem,
  insertProject,
  type PipelineHarness,
} from "./pipeline-support";
import { appWith, insertChannel, insertPost, runDue, testKeyring } from "./publisher-support";

// Insights ingestion. Each platform's answer is a fixture shaped like Meta's references; the
// handler runs on a real scheduler against a scripted `fetch`, so no call leaves the process.

/** An insights answer: `{data: [{name, period, values: [{value}]}]}`. */
function insightsBody(values: Record<string, unknown>, extra: JsonObject = {}): JsonObject {
  return {
    data: Object.entries(values).map(([name, value]) => ({
      name,
      period: "lifetime",
      values: [{ value }],
      title: name,
      id: `media/insights/${name}/lifetime`,
    })),
    ...extra,
  };
}

describe("normalization per platform", () => {
  it("reads Instagram Reels insights", () => {
    const body = insightsBody({
      views: 1_200,
      reach: 900,
      likes: 80,
      comments: 7,
      shares: 12,
      saved: 30,
      total_interactions: 129,
      ig_reels_avg_watch_time: 8_450,
    });
    expect(normalizeInsights("instagram", body)).toEqual({
      views: 1_200,
      likes: 80,
      comments: 7,
      shares: 12,
      saves: 30,
      reach: 900,
      avgWatchMs: 8_450,
      raw: body,
    });
  });

  it("leaves unreported metrics null and reads total_value answers", () => {
    const body = {
      data: [
        { name: "views", period: "lifetime", total_value: { value: 40 } },
        { name: "likes", period: "lifetime", values: [{ value: "3" }] },
        { name: "comments", period: "lifetime", values: [{ value: -1 }] },
        { name: "shares", period: "lifetime", values: [] },
      ],
    };
    expect(normalizeInsights("instagram", body)).toMatchObject({
      views: 40,
      likes: 3,
      comments: null,
      shares: null,
      saves: null,
      reach: null,
      avgWatchMs: null,
    });
    expect(normalizeInsights("instagram", { error: "nope" })).toMatchObject({ views: null });
  });

  it("reads Facebook Reels plays, reactions and social actions", () => {
    const body = insightsBody({
      blue_reels_play_count: 500,
      fb_reels_total_plays: 640,
      post_impressions_unique: 410,
      post_video_avg_time_watched: 6_100.4,
      post_video_likes_by_reaction_type: { REACTION_LIKE: 20, REACTION_LOVE: 5 },
      post_video_social_actions: { COMMENT: 4, SHARE: 9 },
    });
    expect(normalizeInsights("facebook", body)).toEqual({
      views: 640,
      likes: 25,
      comments: 4,
      shares: 9,
      saves: null,
      reach: 410,
      avgWatchMs: 6_100,
      raw: body,
    });
    // Without total plays the initial plays stand in.
    expect(
      normalizeInsights("facebook", insightsBody({ blue_reels_play_count: 77 })),
    ).toMatchObject({ views: 77, likes: null, comments: null, shares: null });
  });

  it("reads Threads views and folds reposts and quotes into shares", () => {
    const body = insightsBody({
      views: 300,
      likes: 21,
      replies: 4,
      reposts: 3,
      quotes: 1,
      shares: 2,
    });
    expect(normalizeInsights("threads", body)).toEqual({
      views: 300,
      likes: 21,
      comments: 4,
      shares: 6,
      saves: null,
      reach: null,
      avgWatchMs: null,
      raw: body,
    });
    expect(normalizeInsights("threads", insightsBody({ views: 1 }))).toMatchObject({
      shares: null,
    });
  });

  it("keeps the raw answer without paging links or credentials", () => {
    const token = fakeCredential("paging");
    const body = insightsBody(
      { views: 1, note: `https://graph.example.test/next?access_token=${token}&after=x` },
      { paging: { next: `https://graph.example.test/next?access_token=${token}` } },
    );
    const raw = normalizeInsights("instagram", body).raw;
    expect(JSON.stringify(raw)).not.toContain(token);
    expect(raw).not.toHaveProperty("paging");
    expect(
      stripCredentials({
        access_token: token,
        nested: [{ appsecret_proof: fakeCredential("proof"), ok: 1 }],
      }),
    ).toEqual({
      nested: [{ ok: 1 }],
    });
  });

  it("builds each platform's insights call", () => {
    expect(insightsRequest("instagram", "179")).toEqual({
      api: "graph",
      path: "/179/insights",
      query: { metric: INSTAGRAM_INSIGHTS_METRICS.join(",") },
    });
    expect(insightsRequest("facebook", "88")).toEqual({
      api: "graph",
      path: "/88/video_insights",
      query: { metric: FACEBOOK_REELS_INSIGHTS_METRICS.join(","), period: "lifetime" },
    });
    expect(insightsRequest("threads", "a/b")).toEqual({
      api: "threads",
      path: "/a%2Fb/insights",
      query: { metric: THREADS_INSIGHTS_METRICS.join(",") },
    });
  });
});

// Scheduler integration --------------------------------------------------------------------------

let h: PipelineHarness;
let projectId: string;
const keyring = testKeyring();

beforeAll(async () => {
  h = await createPipelineHarness();
  projectId = await insertProject(h);
});

afterEach(async () => {
  await h.db.delete(scheduledTasks);
});

afterAll(async () => {
  await h.close();
});

interface SeenCall {
  url: URL;
  headers: Headers;
}

interface ScriptedReply {
  status?: number;
  body: unknown;
  headers?: Record<string, string>;
}

/** A `fetch` answering each call with the next scripted reply; any extra call fails the run. */
function scripted(replies: ScriptedReply[]) {
  const calls: SeenCall[] = [];
  const fetch = async (input: string, init: RequestInit): Promise<Response> => {
    calls.push({ url: new URL(input), headers: new Headers(init.headers) });
    const reply = replies.shift();
    if (reply === undefined) throw new Error(`unexpected call to ${new URL(input).pathname}`);
    return new Response(JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { "content-type": "application/json", ...reply.headers },
    });
  };
  return { fetch, calls };
}

interface Harness {
  scheduler: Scheduler;
  appSecret: string;
  refused: string[];
  close(): Promise<void>;
}

function insightsServer(fetch: ReturnType<typeof scripted>["fetch"]): Harness {
  const { t, deps } = appWith(h.db, { clock: h.t.clock, config: { encryption: keyring } });
  t.bus.subscribeLive((event) => void h.live.push(event));
  const scheduler = createScheduler({
    db: h.db,
    bus: t.bus,
    clock: h.t.clock,
    logger: deps.logger,
    config: { enabled: true, tickMs: 5_000 },
    random: () => 0.5,
  });
  const refused: string[] = [];
  const platforms = testPlatforms();
  registerInsightsTasks({
    db: h.db,
    bus: t.bus,
    logger: deps.logger,
    scheduler,
    vault: deps.vault,
    platforms,
    fetch,
    sleep: async () => undefined,
    onCredentialsRefused: async ({ channelId }) => void refused.push(channelId),
  });
  return {
    scheduler,
    appSecret: platforms.meta?.appSecret ?? "",
    refused,
    close: async () => {
      await scheduler.stop(1_000);
      await t.deps.lifecycle.close();
    },
  };
}

/** A live post published on a connected channel of `platform`, and its pull due now. */
async function livePost(
  platform: Platform,
  options: { dryRun?: boolean; status?: "published" | "queued" } = {},
) {
  const channel = await insertChannel(h.db, keyring, {
    platform,
    connected: true,
    status: "active",
    dryRun: false,
  });
  const item = await insertItem(h, { projectId, state: "published", level: "render" });
  const postId = await insertPost(h.db, {
    itemId: item.itemId,
    versionId: item.versionId,
    channelId: channel.id,
    scheduledAt: h.t.clock.now(),
    status: "queued",
    dryRun: options.dryRun ?? false,
  });
  const mediaId = String(18_000_000_000 + Math.floor(Math.random() * 1e9));
  await h.db
    .update(scheduledPosts)
    .set({
      status: options.status ?? "published",
      externalId: mediaId,
      publishedAt: options.status === "queued" ? null : h.t.clock.now(),
    })
    .where(eq(scheduledPosts.id, postId));
  await h.deps.scheduler.enqueue(
    "insights.pull",
    { postId },
    { runAt: h.t.clock.now(), dedupeKey: insightsDedupeKey(postId, 0) },
  );
  return { channel, item, postId, mediaId };
}

async function capturesOf(postId: string) {
  return h.db.select().from(postMetrics).where(eq(postMetrics.postId, postId));
}

async function tasksOf(kind: string) {
  return h.db.select().from(scheduledTasks).where(eq(scheduledTasks.kind, kind));
}

async function rateLimitOf(channelId: string) {
  const [row] = await h.db
    .select({ rateLimit: channels.rateLimit })
    .from(channels)
    .where(eq(channels.id, channelId));
  return row?.rateLimit ?? null;
}

describe("schedule generation", () => {
  it("enqueues one pull per insights schedule time, once", async () => {
    const { postId } = await livePost("instagram");
    await h.db.delete(scheduledTasks);
    const publishedAt = new Date("2026-10-01T09:30:00.000Z");
    const enqueue = () =>
      transaction(h.db, (tx) =>
        enqueueInsightsPulls(h.deps.scheduler, tx, { postId, platform: "instagram", publishedAt }),
      );
    const times = await enqueue();
    await enqueue();
    expect(times).toEqual(
      INSIGHTS_SCHEDULE_OFFSETS_MS.map((offset) => new Date(publishedAt.getTime() + offset)),
    );
    const tasks = await tasksOf("insights.pull");
    expect(tasks).toHaveLength(INSIGHTS_SCHEDULE_OFFSETS_MS.length);
    expect(tasks.map((task) => [task.dedupeKey, task.runAt.toISOString()]).sort()).toEqual(
      times.map((time, index) => [insightsDedupeKey(postId, index), time.toISOString()]).sort(),
    );
    expect(tasks.every((task) => (task.payload as JsonObject).postId === postId)).toBe(true);
  });

  it("schedules nothing for a platform without insights", async () => {
    const enqueued = await transaction(h.db, (tx) =>
      enqueueInsightsPulls(h.deps.scheduler, tx, {
        postId: crypto.randomUUID(),
        platform: "x",
        publishedAt: new Date(),
      }),
    );
    expect(enqueued).toEqual([]);
    expect(await tasksOf("insights.pull")).toEqual([]);
  });
});

describe("insights.pull", () => {
  it("stores an Instagram capture with the raw answer and announces it", async () => {
    const body = insightsBody({ views: 1_000, reach: 800, likes: 50, saved: 9 });
    const fake = scripted([
      { body, headers: { "x-app-usage": JSON.stringify({ call_count: 12 }) } },
    ]);
    const server = insightsServer(fake.fetch);
    try {
      const { channel, item, postId, mediaId } = await livePost("instagram");
      await runDue(server.scheduler);

      const [call] = fake.calls;
      expect(call?.url.origin).toBe(GRAPH_ORIGIN);
      expect(call?.url.pathname).toBe(`/${GRAPH_VERSION}/${mediaId}/insights`);
      expect(call?.url.searchParams.get("metric")).toBe(INSTAGRAM_INSIGHTS_METRICS.join(","));
      expect(call?.headers.get("authorization")).toBe(`Bearer ${channel.token}`);
      expect(call?.url.searchParams.get("appsecret_proof")).toBe(
        appSecretProof(String(channel.token), server.appSecret),
      );

      const [capture, ...others] = await capturesOf(postId);
      expect(others).toEqual([]);
      expect(capture).toMatchObject({
        views: 1_000,
        reach: 800,
        likes: 50,
        saves: 9,
        comments: null,
        raw: body,
      });
      expect(capture?.capturedAt).toEqual(h.t.clock.now());
      const event = eventsOf(h.live, "post.metrics.updated").find(
        (entry) => entry.payload.postId === postId,
      );
      expect(event?.payload).toEqual({
        postId,
        itemId: item.itemId,
        projectId,
        channelId: channel.id,
        platform: "instagram",
        metrics: {
          capturedAt: h.t.clock.now().toISOString(),
          views: 1_000,
          likes: 50,
          comments: null,
          shares: null,
          saves: 9,
          reach: 800,
          avgWatchMs: null,
        },
      });
      expect(await rateLimitOf(channel.id)).toMatchObject({ appUsage: { call_count: 12 } });
    } finally {
      await server.close();
    }
  });

  it("asks the Threads API with the token as a parameter", async () => {
    const fake = scripted([{ body: insightsBody({ views: 10, likes: 2, replies: 1 }) }]);
    const server = insightsServer(fake.fetch);
    try {
      const { channel, postId, mediaId } = await livePost("threads");
      await runDue(server.scheduler);
      const [call] = fake.calls;
      expect(call?.url.origin).toBe(THREADS_API_ORIGIN);
      expect(call?.url.pathname).toBe(`/v1.0/${mediaId}/insights`);
      expect(call?.url.searchParams.get("access_token")).toBe(channel.token);
      expect(await capturesOf(postId)).toMatchObject([{ views: 10, likes: 2, comments: 1 }]);
    } finally {
      await server.close();
    }
  });

  it("makes no call while the channel is over its usage threshold", async () => {
    const fake = scripted([]);
    const server = insightsServer(fake.fetch);
    try {
      const { channel, postId } = await livePost("facebook");
      const now = h.t.clock.now();
      const until = new Date(now.getTime() + 40 * 60_000);
      await h.db
        .update(channels)
        .set({
          rateLimit: {
            capturedAt: now.toISOString(),
            businessUseCaseUsage: {
              "42": [{ type: "pages", call_count: 100, estimated_time_to_regain_access: 40 }],
            },
          },
        })
        .where(eq(channels.id, channel.id));
      await runDue(server.scheduler);

      expect(fake.calls).toEqual([]);
      expect(await capturesOf(postId)).toEqual([]);
      const pending = (await tasksOf("insights.pull")).filter((task) => task.status === "pending");
      expect(pending.map((task) => task.runAt)).toEqual([until]);
    } finally {
      await server.close();
    }
  });

  it("backs off a rate-limit error and holds the channel", async () => {
    const fake = scripted([
      {
        status: 400,
        body: {
          error: { message: "Application request limit reached", code: 4, type: "OAuthException" },
        },
      },
    ]);
    const server = insightsServer(fake.fetch);
    try {
      const { channel, postId } = await livePost("instagram");
      const now = h.t.clock.now();
      await runDue(server.scheduler);
      expect(fake.calls).toHaveLength(1);
      expect(await capturesOf(postId)).toEqual([]);
      const report = await rateLimitOf(channel.id);
      const blockedUntil = Date.parse(String(report?.blockedUntil));
      expect(blockedUntil).toBeGreaterThan(now.getTime());
      const pending = (await tasksOf("insights.pull")).filter((task) => task.status === "pending");
      expect(pending.map((task) => task.runAt.getTime())).toEqual([blockedUntil]);
    } finally {
      await server.close();
    }
  });

  it("flags refused credentials and stops", async () => {
    const fake = scripted([
      {
        status: 400,
        body: { error: { message: "Session expired", code: 190, type: "OAuthException" } },
      },
    ]);
    const server = insightsServer(fake.fetch);
    try {
      const { channel, postId } = await livePost("facebook");
      await runDue(server.scheduler);
      expect(server.refused).toEqual([channel.id]);
      expect(await capturesOf(postId)).toEqual([]);
      const [task] = await tasksOf("insights.pull");
      expect(task?.status).toBe("failed");
    } finally {
      await server.close();
    }
  });

  it("skips dry-run, unpublished and already covered posts", async () => {
    const fake = scripted([]);
    const server = insightsServer(fake.fetch);
    try {
      await livePost("instagram", { dryRun: true });
      await livePost("instagram", { status: "queued" });
      const covered = await livePost("threads");
      await h.db.insert(postMetrics).values({
        postId: covered.postId,
        capturedAt: new Date(h.t.clock.now().getTime() + 1_000),
        views: 5,
      });
      await runDue(server.scheduler);
      expect(fake.calls).toEqual([]);
      const tasks = await tasksOf("insights.pull");
      expect(tasks.map((task) => task.status)).toEqual(["succeeded", "succeeded", "succeeded"]);
    } finally {
      await server.close();
    }
  });
});
