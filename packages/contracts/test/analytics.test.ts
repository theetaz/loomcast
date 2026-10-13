import { describe, expect, it } from "vitest";
import {
  AnalyticsAggregateSchema,
  AnalyticsOverviewQuerySchema,
  AnalyticsOverviewSchema,
  aggregatePosts,
  buildPath,
  DailyViewsSchema,
  INSIGHTS_SCHEDULE_OFFSETS_MS,
  ItemAnalyticsSchema,
  insightsSchedule,
  type PostMetricCounts,
  type PostMetrics,
  PostMetricsSchema,
  type PostPerformance,
  routes,
  SeriesAnalyticsQuerySchema,
} from "../src";
import { at, ids } from "./fixtures";

function counts(values: Partial<PostMetricCounts>): PostMetricCounts {
  return {
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

const capture: PostMetrics = {
  capturedAt: at,
  views: 1_000,
  likes: 50,
  comments: 5,
  shares: 3,
  saves: 2,
  reach: 800,
  avgWatchMs: 12_000,
};

const performance: PostPerformance = {
  postId: ids.post,
  itemId: ids.item,
  projectId: ids.project,
  seriesId: ids.series,
  channelId: ids.channel,
  platform: "instagram",
  title: "Rust ownership in 60 seconds",
  permalink: "https://www.instagram.com/reel/abc123/",
  publishedAt: at,
  metrics: capture,
};

describe("insights schedule", () => {
  it("captures 1 h, 6 h, 24 h, 72 h, 7 d, 14 d and 30 d after publishing", () => {
    expect(insightsSchedule("2026-10-12T09:30:00.000Z").map((date) => date.toISOString())).toEqual([
      "2026-10-12T10:30:00.000Z",
      "2026-10-12T15:30:00.000Z",
      "2026-10-13T09:30:00.000Z",
      "2026-10-15T09:30:00.000Z",
      "2026-10-19T09:30:00.000Z",
      "2026-10-26T09:30:00.000Z",
      "2026-11-11T09:30:00.000Z",
    ]);
  });

  it("accepts a Date and keeps the times in order", () => {
    const publishedAt = new Date(at);
    const times = insightsSchedule(publishedAt).map((date) => date.getTime());

    expect(times).toHaveLength(INSIGHTS_SCHEDULE_OFFSETS_MS.length);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(times[0]).toBe(publishedAt.getTime() + 60 * 60_000);
  });

  it("uses offsets, so time zones and daylight saving do not shift it", () => {
    const times = insightsSchedule("2026-10-24T12:00:00+02:00").map((date) => date.toISOString());

    expect(times[4]).toBe("2026-10-31T10:00:00.000Z");
  });

  it("throws for an invalid time", () => {
    expect(() => insightsSchedule("not a time")).toThrow(RangeError);
    expect(() => insightsSchedule(new Date(Number.NaN))).toThrow(RangeError);
  });
});

describe("aggregatePosts", () => {
  it("returns zeros and nulls for no posts", () => {
    expect(aggregatePosts([])).toEqual({
      posts: 0,
      measuredPosts: 0,
      views: 0,
      likes: 0,
      comments: 0,
      shares: 0,
      saves: 0,
      reach: 0,
      medianViews: null,
      engagementRate: null,
      avgWatchMs: null,
    });
  });

  it("sums the latest captures and computes the engagement rate", () => {
    const result = aggregatePosts([
      counts({ views: 1_000, likes: 50, comments: 10, shares: 5, saves: 15, reach: 900 }),
      counts({ views: 3_000, likes: 100, comments: 20, shares: 10, saves: 30, reach: 2_000 }),
    ]);

    expect(result).toMatchObject({
      posts: 2,
      measuredPosts: 2,
      views: 4_000,
      likes: 150,
      comments: 30,
      shares: 15,
      saves: 45,
      reach: 2_900,
      medianViews: 2_000,
    });
    expect(result.engagementRate).toBeCloseTo(240 / 4_000);
    expect(AnalyticsAggregateSchema.parse(result)).toEqual(result);
  });

  it("has no engagement rate or watch time while views are zero", () => {
    const result = aggregatePosts([counts({ views: 0, likes: 3, avgWatchMs: 9_000 })]);

    expect(result.views).toBe(0);
    expect(result.likes).toBe(3);
    expect(result.medianViews).toBe(0);
    expect(result.engagementRate).toBeNull();
    expect(result.avgWatchMs).toBeNull();
  });

  it("counts posts without a capture but adds nothing for them", () => {
    const result = aggregatePosts([null, counts({ views: 400, likes: 40 }), null]);

    expect(result.posts).toBe(3);
    expect(result.measuredPosts).toBe(1);
    expect(result.views).toBe(400);
    expect(result.medianViews).toBe(400);
    expect(result.engagementRate).toBeCloseTo(0.1);
  });

  it("counts metrics a platform does not report as zero", () => {
    const result = aggregatePosts([
      counts({ views: 200, likes: 10, comments: 2, shares: 4 }),
      counts({ views: 100, likes: 5, saves: 5, reach: 90 }),
    ]);

    expect(result).toMatchObject({ saves: 5, reach: 90, likes: 15, comments: 2, shares: 4 });
    expect(result.engagementRate).toBeCloseTo(26 / 300);
  });

  it("takes the median over the posts that report views", () => {
    expect(
      aggregatePosts([
        counts({ views: 900 }),
        counts({ views: null, likes: 7 }),
        counts({ views: 100 }),
        counts({ views: 300 }),
      ]).medianViews,
    ).toBe(300);
    expect(
      aggregatePosts([counts({ views: 10 }), counts({ views: 40 }), counts({ views: 25 }), null])
        .medianViews,
    ).toBe(25);
    expect(aggregatePosts([counts({ views: 10 }), counts({ views: 15 })]).medianViews).toBe(12.5);
    expect(aggregatePosts([counts({ likes: 4 })]).medianViews).toBeNull();
  });

  it("weights the average watch time by views", () => {
    const result = aggregatePosts([
      counts({ views: 1_000, avgWatchMs: 10_000 }),
      counts({ views: 3_000, avgWatchMs: 20_000 }),
      counts({ views: 500, avgWatchMs: null }),
      counts({ views: null, avgWatchMs: 90_000 }),
    ]);

    expect(result.avgWatchMs).toBe(17_500);
  });
});

describe("post metrics", () => {
  it("accepts a full capture and one with unreported metrics", () => {
    expect(PostMetricsSchema.parse(capture)).toEqual(capture);
    const threads = { ...capture, saves: null, reach: null, avgWatchMs: null };
    expect(PostMetricsSchema.parse(threads)).toEqual(threads);
  });

  it("rejects negative, fractional and missing counts", () => {
    expect(PostMetricsSchema.safeParse({ ...capture, views: -1 }).success).toBe(false);
    expect(PostMetricsSchema.safeParse({ ...capture, likes: 1.5 }).success).toBe(false);
    const { reach: _reach, ...withoutReach } = capture;
    expect(PostMetricsSchema.safeParse(withoutReach).success).toBe(false);
  });
});

describe("analytics responses and queries", () => {
  it("bounds the overview range to 366 days, ending after it starts", () => {
    const from = "2026-01-01T00:00:00.000Z";

    expect(
      AnalyticsOverviewQuerySchema.parse({
        from,
        to: "2027-01-02T00:00:00.000Z",
        projectId: ids.project,
      }),
    ).toEqual({ from, to: "2027-01-02T00:00:00.000Z", projectId: ids.project });
    expect(
      AnalyticsOverviewQuerySchema.safeParse({ from, to: "2027-01-02T00:00:00.001Z" }).success,
    ).toBe(false);
    expect(AnalyticsOverviewQuerySchema.safeParse({ from, to: from }).success).toBe(false);
    expect(AnalyticsOverviewQuerySchema.safeParse({ from }).success).toBe(false);
  });

  it("takes an optional series range", () => {
    expect(SeriesAnalyticsQuerySchema.parse({})).toEqual({});
    expect(SeriesAnalyticsQuerySchema.parse({ from: at })).toEqual({ from: at });
    expect(
      SeriesAnalyticsQuerySchema.safeParse({ from: at, to: "2026-10-01T00:00:00.000Z" }).success,
    ).toBe(false);
  });

  it("keys daily views by UTC date", () => {
    const row = { date: "2026-10-12", platform: "threads", posts: 2, views: 340 };

    expect(DailyViewsSchema.parse(row)).toEqual(row);
    expect(DailyViewsSchema.safeParse({ ...row, date: "2026-10-12T00:00:00Z" }).success).toBe(
      false,
    );
    expect(DailyViewsSchema.safeParse({ ...row, posts: 0 }).success).toBe(false);
  });

  it("round-trips an overview and an item's analytics", () => {
    const totals = aggregatePosts([capture, null]);
    const overview = {
      from: "2026-10-01T00:00:00.000Z",
      to: "2026-11-01T00:00:00.000Z",
      totals,
      platforms: [{ platform: "instagram" as const, totals }],
      daily: [{ date: "2026-10-12", platform: "instagram" as const, posts: 2, views: 1_000 }],
      topPosts: [performance, { ...performance, metrics: null, permalink: null }],
    };
    const item = {
      itemId: ids.item,
      totals,
      posts: [{ post: performance, history: [capture], nextCaptureAt: null }],
    };

    expect(AnalyticsOverviewSchema.parse(overview)).toEqual(overview);
    expect(ItemAnalyticsSchema.parse(item)).toEqual(item);
    expect(
      AnalyticsOverviewSchema.safeParse({
        ...overview,
        topPosts: Array.from({ length: 11 }, () => performance),
      }).success,
    ).toBe(false);
  });

  it("serves analytics from session routes", () => {
    const names = Object.keys(routes).filter((name) => name.startsWith("analytics."));

    expect(names.sort()).toEqual([
      "analytics.item",
      "analytics.overview",
      "analytics.post",
      "analytics.series",
    ]);
    for (const name of names) {
      const route = routes[name as keyof typeof routes];
      expect(route.auth, name).toBe("session");
      expect(route.method, name).toBe("GET");
    }
    expect(buildPath(routes["analytics.post"].path, { id: ids.post })).toBe(
      `/api/analytics/posts/${ids.post}`,
    );
    expect(buildPath(routes["analytics.series"].path, { id: ids.series })).toBe(
      `/api/analytics/series/${ids.series}`,
    );
    expect(routes["analytics.overview"].path).toBe("/api/analytics/overview");
  });
});
