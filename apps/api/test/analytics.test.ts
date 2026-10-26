import {
  type AnalyticsOverview,
  AnalyticsOverviewSchema,
  aggregatePosts,
  DEFAULT_FORMAT_RULES,
  type ItemAnalytics,
  ItemAnalyticsSchema,
  type Platform,
  type PostAnalytics,
  PostAnalyticsSchema,
  type PostMetrics,
  type PostPerformance,
  type SeriesAnalytics,
  SeriesAnalyticsSchema,
} from "@loomcast/contracts";
import { postMetrics, scheduledPosts } from "@loomcast/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nextCaptureAt, overviewOf } from "../src/modules/analytics";
import { formatsServiceFor } from "../src/modules/formats";
import { seriesServiceFor } from "../src/modules/series";
import {
  call,
  createPipelineHarness,
  insertItem,
  insertWorkspace,
  type PipelineHarness,
  userOf,
} from "./pipeline-support";
import { insertChannel, insertPost, testKeyring } from "./publisher-support";
import { send } from "./support";

// The analytics endpoints against posts and captures written straight to the database. Expected
// totals come from the contracts' `aggregatePosts`, the function the web app's mock API uses too.

const HOUR = 60 * 60_000;

let h: PipelineHarness;
const keyring = testKeyring();
let workspaceA: string;
let workspaceB: string;
let seriesId: string;
const posts: Record<string, PostPerformance> = {};
const histories: Record<string, PostMetrics[]> = {};
let itemOne: string;
let dryRunPost: string;

function counts(metrics: PostMetrics | null) {
  if (metrics === null) return null;
  const { capturedAt: _capturedAt, ...rest } = metrics;
  return rest;
}

function capture(at: Date, values: Partial<Omit<PostMetrics, "capturedAt">>): PostMetrics {
  return {
    capturedAt: at.toISOString(),
    views: null,
    likes: null,
    comments: null,
    shares: null,
    saves: null,
    reach: null,
    avgWatchMs: null,
    ...values,
  };
}

/** A post of `itemId` published on a new channel of `platform`, with `captures`. */
async function published(
  key: string,
  input: {
    item: {
      itemId: string;
      versionId: string;
      workspaceId: string;
      seriesId: string | null;
      title: string;
    };
    platform: Platform;
    publishedAt: string;
    captures?: PostMetrics[];
    dryRun?: boolean;
  },
): Promise<string> {
  const channel = await insertChannel(h.db, keyring, {
    platform: input.platform,
    connected: true,
    status: "active",
    dryRun: false,
  });
  const postId = await insertPost(h.db, {
    itemId: input.item.itemId,
    versionId: input.item.versionId,
    channelId: channel.id,
    scheduledAt: new Date(input.publishedAt),
    dryRun: input.dryRun ?? false,
    seriesId: input.item.seriesId,
  });
  const permalink = `https://www.example.test/${input.platform}/${key}`;
  await h.db
    .update(scheduledPosts)
    .set({ status: "published", publishedAt: new Date(input.publishedAt), permalink })
    .where(eq(scheduledPosts.id, postId));
  const captures = input.captures ?? [];
  for (const entry of captures) {
    const { capturedAt, ...values } = entry;
    await h.db.insert(postMetrics).values({ postId, capturedAt: new Date(capturedAt), ...values });
  }
  posts[key] = {
    postId,
    itemId: input.item.itemId,
    workspaceId: input.item.workspaceId,
    seriesId: input.item.seriesId,
    channelId: channel.id,
    platform: input.platform,
    title: input.item.title,
    permalink,
    publishedAt: new Date(input.publishedAt).toISOString(),
    metrics: captures.at(-1) ?? null,
  };
  histories[key] = captures;
  return postId;
}

function post(key: string): PostPerformance {
  const found = posts[key];
  if (found === undefined) throw new Error(`no post ${key}`);
  return found;
}

beforeAll(async () => {
  h = await createPipelineHarness();
  workspaceA = await insertWorkspace(h);
  workspaceB = await insertWorkspace(h);
  const format = await formatsServiceFor(h.deps).create(
    workspaceA,
    { name: "Rust format", rules: structuredClone(DEFAULT_FORMAT_RULES) },
    userOf(h),
  );
  const series = await seriesServiceFor(h.deps).create(
    workspaceA,
    { name: "Rust in 60", formatId: format.id },
    userOf(h),
  );
  seriesId = series.id;

  const one = await insertItem(h, {
    workspaceId: workspaceA,
    seriesId,
    title: "Ownership",
    state: "published",
    level: "render",
  });
  const two = await insertItem(h, {
    workspaceId: workspaceA,
    seriesId,
    title: "Borrowing",
    state: "published",
    level: "render",
  });
  const three = await insertItem(h, {
    workspaceId: workspaceB,
    title: "Agents",
    state: "published",
    level: "render",
  });
  itemOne = one.itemId;
  const itemOf = (item: typeof one, title: string, series: string | null, workspaceId: string) => ({
    itemId: item.itemId,
    versionId: item.versionId,
    workspaceId,
    seriesId: series,
    title,
  });

  const p1At = new Date("2026-09-01T10:00:00.000Z");
  await published("p1", {
    item: itemOf(one, "Ownership", seriesId, workspaceA),
    platform: "instagram",
    publishedAt: p1At.toISOString(),
    captures: [
      capture(new Date(p1At.getTime() + HOUR), { views: 100, likes: 10 }),
      capture(new Date(p1At.getTime() + 6 * HOUR), {
        views: 400,
        likes: 30,
        saves: 5,
        reach: 300,
        avgWatchMs: 9_000,
      }),
    ],
  });
  await published("p2", {
    item: itemOf(one, "Ownership", seriesId, workspaceA),
    platform: "facebook",
    publishedAt: "2026-09-01T11:00:00.000Z",
    captures: [
      capture(new Date("2026-09-02T11:00:00.000Z"), {
        views: 200,
        likes: 4,
        comments: 2,
        shares: 1,
        avgWatchMs: 6_000,
      }),
    ],
  });
  await published("p3", {
    item: itemOf(two, "Borrowing", seriesId, workspaceA),
    platform: "threads",
    publishedAt: "2026-09-10T08:00:00.000Z",
  });
  await published("p4", {
    item: itemOf(three, "Agents", null, workspaceB),
    platform: "instagram",
    publishedAt: "2026-09-02T17:00:00.000Z",
    captures: [capture(new Date("2026-09-03T17:00:00.000Z"), { views: 1_000, likes: 70 })],
  });
  dryRunPost = await published("dry", {
    item: itemOf(two, "Borrowing", seriesId, workspaceA),
    platform: "facebook",
    publishedAt: "2026-09-10T09:00:00.000Z",
    dryRun: true,
    captures: [capture(new Date("2026-09-11T09:00:00.000Z"), { views: 9_999 })],
  });
  // A queued post of the same item never counts.
  const queuedChannel = await insertChannel(h.db, keyring, { platform: "instagram" });
  await insertPost(h.db, {
    itemId: two.itemId,
    versionId: two.versionId,
    channelId: queuedChannel.id,
    scheduledAt: new Date("2026-09-12T08:00:00.000Z"),
    dryRun: false,
  });
});

afterAll(async () => {
  await h.close();
});

async function getJson<T>(path: string): Promise<{ status: number; body: T }> {
  const response = await call(h, "GET", path);
  return { status: response.status, body: (await response.json()) as T };
}

describe("GET /api/analytics/posts/:id", () => {
  it("returns the post, its captures oldest first and the next capture time", async () => {
    const { status, body } = await getJson<PostAnalytics>(
      `/api/analytics/posts/${post("p1").postId}`,
    );
    expect(status).toBe(200);
    expect(PostAnalyticsSchema.parse(body)).toEqual(body);
    expect(body).toEqual({
      post: post("p1"),
      history: histories.p1,
      nextCaptureAt: "2026-09-02T10:00:00.000Z",
    });
  });

  it("has no metrics before the first capture", async () => {
    const { body } = await getJson<PostAnalytics>(`/api/analytics/posts/${post("p3").postId}`);
    expect(body).toEqual({
      post: post("p3"),
      history: [],
      nextCaptureAt: "2026-09-10T09:00:00.000Z",
    });
  });

  it("answers 404 for dry-run, unknown and malformed ids", async () => {
    for (const id of [dryRunPost, crypto.randomUUID(), "not-a-uuid"]) {
      const response = await call(h, "GET", `/api/analytics/posts/${id}`);
      expect(response.status).toBe(404);
    }
  });

  it("requires a session", async () => {
    const response = await send(h.t.app, "GET", `/api/analytics/posts/${post("p1").postId}`);
    expect(response.status).toBe(401);
  });
});

describe("GET /api/analytics/items/:id", () => {
  it("returns every live post of the item with totals", async () => {
    const { status, body } = await getJson<ItemAnalytics>(`/api/analytics/items/${itemOne}`);
    expect(status).toBe(200);
    expect(ItemAnalyticsSchema.parse(body)).toEqual(body);
    expect(body.totals).toEqual(
      aggregatePosts([counts(post("p1").metrics), counts(post("p2").metrics)]),
    );
    expect(body.posts.map((entry) => entry.post)).toEqual([post("p1"), post("p2")]);
    expect(body.posts[1]?.history).toEqual(histories.p2);
  });

  it("answers 404 for an unknown item", async () => {
    const response = await call(h, "GET", `/api/analytics/items/${crypto.randomUUID()}`);
    expect(response.status).toBe(404);
  });
});

describe("GET /api/analytics/series/:id", () => {
  it("returns the series' live posts oldest first with totals", async () => {
    const { status, body } = await getJson<SeriesAnalytics>(`/api/analytics/series/${seriesId}`);
    expect(status).toBe(200);
    expect(SeriesAnalyticsSchema.parse(body)).toEqual(body);
    expect(body).toEqual({
      seriesId,
      totals: aggregatePosts(["p1", "p2", "p3"].map((key) => counts(post(key).metrics))),
      posts: [post("p1"), post("p2"), post("p3")],
    });
  });

  it("filters by publish time in [from, to)", async () => {
    const query = "from=2026-09-01T11:00:00.000Z&to=2026-09-10T08:00:00.000Z";
    const { body } = await getJson<SeriesAnalytics>(`/api/analytics/series/${seriesId}?${query}`);
    expect(body.posts).toEqual([post("p2")]);
    expect(body.totals).toEqual(aggregatePosts([counts(post("p2").metrics)]));
  });

  it("refuses an inverted range and an unknown series", async () => {
    const bad = await call(
      h,
      "GET",
      `/api/analytics/series/${seriesId}?from=2026-09-10T00:00:00.000Z&to=2026-09-01T00:00:00.000Z`,
    );
    expect(bad.status).toBe(400);
    const missing = await call(h, "GET", `/api/analytics/series/${crypto.randomUUID()}`);
    expect(missing.status).toBe(404);
  });
});

describe("GET /api/analytics/overview", () => {
  const range = "from=2026-08-01T00:00:00.000Z&to=2026-10-01T00:00:00.000Z";

  it("aggregates totals, platforms, daily views and top posts", async () => {
    const { status, body } = await getJson<AnalyticsOverview>(`/api/analytics/overview?${range}`);
    expect(status).toBe(200);
    expect(AnalyticsOverviewSchema.parse(body)).toEqual(body);
    const all = ["p1", "p2", "p4", "p3"].map(post);
    expect(body.from).toBe("2026-08-01T00:00:00.000Z");
    expect(body.to).toBe("2026-10-01T00:00:00.000Z");
    expect(body.totals).toEqual(aggregatePosts(all.map((entry) => counts(entry.metrics))));
    expect(body.platforms).toEqual([
      { platform: "facebook", totals: aggregatePosts([counts(post("p2").metrics)]) },
      {
        platform: "instagram",
        totals: aggregatePosts([counts(post("p1").metrics), counts(post("p4").metrics)]),
      },
      { platform: "threads", totals: aggregatePosts([null]) },
    ]);
    expect(body.daily).toEqual([
      { date: "2026-09-01", platform: "facebook", posts: 1, views: 200 },
      { date: "2026-09-01", platform: "instagram", posts: 1, views: 400 },
      { date: "2026-09-02", platform: "instagram", posts: 1, views: 1_000 },
      { date: "2026-09-10", platform: "threads", posts: 1, views: 0 },
    ]);
    expect(body.topPosts).toEqual([post("p4"), post("p1"), post("p2"), post("p3")]);
  });

  it("narrows to one workspace", async () => {
    const { body } = await getJson<AnalyticsOverview>(
      `/api/analytics/overview?${range}&workspaceId=${workspaceB}`,
    );
    expect(body.topPosts).toEqual([post("p4")]);
    expect(body.totals.posts).toBe(1);
    expect(body.totals.views).toBe(1_000);
  });

  it("refuses a missing or too long range", async () => {
    const missing = await call(h, "GET", "/api/analytics/overview?from=2026-08-01T00:00:00.000Z");
    expect(missing.status).toBe(400);
    const long = await call(
      h,
      "GET",
      "/api/analytics/overview?from=2025-01-01T00:00:00.000Z&to=2026-10-01T00:00:00.000Z",
    );
    expect(long.status).toBe(400);
  });
});

describe("aggregates", () => {
  const base = {
    itemId: crypto.randomUUID(),
    workspaceId: crypto.randomUUID(),
    seriesId: null,
    channelId: crypto.randomUUID(),
    title: "t",
    permalink: null,
  };

  function perf(platform: Platform, publishedAt: string, views: number | null): PostPerformance {
    return {
      ...base,
      postId: crypto.randomUUID(),
      platform,
      publishedAt,
      metrics: views === null ? null : capture(new Date(publishedAt), { views, likes: 1 }),
    };
  }

  it("ranks top posts by views with unmeasured posts last and ties in publish order", () => {
    const a = perf("threads", "2026-09-01T00:00:00.000Z", 50);
    const b = perf("instagram", "2026-09-01T23:59:59.000Z", null);
    const c = perf("instagram", "2026-09-02T00:00:00.000Z", 50);
    const d = perf("facebook", "2026-09-03T00:00:00.000Z", 75);
    const overview = overviewOf([a, b, c, d], { from: "f", to: "t" });
    expect(overview.topPosts.map((entry) => entry.postId)).toEqual([
      d.postId,
      a.postId,
      c.postId,
      b.postId,
    ]);
    expect(overview.daily).toEqual([
      { date: "2026-09-01", platform: "instagram", posts: 1, views: 0 },
      { date: "2026-09-01", platform: "threads", posts: 1, views: 50 },
      { date: "2026-09-02", platform: "instagram", posts: 1, views: 50 },
      { date: "2026-09-03", platform: "facebook", posts: 1, views: 75 },
    ]);
    expect(overview.totals).toMatchObject({
      posts: 4,
      measuredPosts: 3,
      views: 175,
      medianViews: 50,
    });
  });

  it("caps top posts and computes the next capture from the schedule", () => {
    const many = Array.from({ length: 12 }, (_, index) =>
      perf("instagram", `2026-09-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`, index),
    );
    expect(overviewOf(many, { from: "f", to: "t" }).topPosts).toHaveLength(10);

    const live = perf("x", "2026-09-01T00:00:00.000Z", null);
    expect(nextCaptureAt(live, [])).toBeNull();
    const ig = perf("instagram", "2026-09-01T00:00:00.000Z", null);
    const last = capture(new Date("2026-10-01T00:00:00.000Z"), { views: 1 });
    expect(nextCaptureAt(ig, [last])).toBeNull();
  });
});
