import type { AnalyticsOverview, PostPerformance } from "@loomcast/contracts";
import { describe, expect, it } from "vitest";
import {
  engagementRate,
  formatCount,
  formatFullCount,
  formatMetric,
  formatRate,
  formatWatch,
  NO_VALUE,
} from "@/features/analytics/format";
import { orderPlatforms, platformColor } from "@/features/analytics/platforms";
import { OverviewSearchSchema, rangeOfDays, seriesRange } from "@/features/analytics/range";
import { canSpark } from "@/features/analytics/Sparkline";
import {
  barLayout,
  barPath,
  bucketStart,
  bucketsBetween,
  granularityFor,
  nearestIndex,
  tickIndices,
  valueScale,
  viewsTrend,
} from "@/features/analytics/scales";
import {
  captureTooltip,
  postMeasure,
  postTooltip,
  tooltipText,
  trendTooltip,
} from "@/features/analytics/tooltips";
import { mockLivePost, overviewOf } from "@/mocks/analytics";
import { capture } from "./support/analytics";

const DAY_MS = 24 * 60 * 60_000;
const utc = (iso: string) => Date.parse(iso);

function overview(
  from: string,
  to: string,
  daily: AnalyticsOverview["daily"],
): Pick<AnalyticsOverview, "from" | "to" | "daily" | "platforms"> {
  return { from, to, daily, platforms: [] };
}

describe("analytics scales", () => {
  it("groups by day up to 45 days, by week up to 200 and by month beyond", () => {
    const from = utc("2026-01-01T00:00:00Z");
    expect(granularityFor(from, from + 30 * DAY_MS)).toBe("day");
    expect(granularityFor(from, from + 45 * DAY_MS)).toBe("day");
    expect(granularityFor(from, from + 90 * DAY_MS)).toBe("week");
    expect(granularityFor(from, from + 365 * DAY_MS)).toBe("month");
  });

  it("starts buckets on UTC days, Mondays and the first of the month", () => {
    const thursday = utc("2026-10-15T22:30:00Z");
    expect(new Date(bucketStart(thursday, "day")).toISOString()).toBe("2026-10-15T00:00:00.000Z");
    expect(new Date(bucketStart(thursday, "week")).toISOString()).toBe("2026-10-12T00:00:00.000Z");
    expect(new Date(bucketStart(thursday, "month")).toISOString()).toBe("2026-10-01T00:00:00.000Z");
    // A Sunday belongs to the week that started the Monday before.
    expect(new Date(bucketStart(utc("2026-10-18T12:00:00Z"), "week")).toISOString()).toBe(
      "2026-10-12T00:00:00.000Z",
    );
  });

  it("covers a range with every bucket, labelled for tooltips and ticks", () => {
    const days = bucketsBetween(utc("2026-09-14T00:00:00Z"), utc("2026-10-14T00:00:00Z"), "day");
    expect(days).toHaveLength(30);
    expect(days[0]).toMatchObject({ label: "Sep 14", tick: "Sep 14" });
    const weeks = bucketsBetween(utc("2026-07-16T00:00:00Z"), utc("2026-10-14T00:00:00Z"), "week");
    expect(weeks[0]?.label).toBe("Week of Jul 13");
    const months = bucketsBetween(
      utc("2025-10-14T00:00:00Z"),
      utc("2026-10-14T00:00:00Z"),
      "month",
    );
    expect(months).toHaveLength(13);
    expect(months[0]).toMatchObject({ label: "Oct 2025", tick: "Oct" });
  });

  it("zero-fills the trend, keeps a running total and fixes the platform order", () => {
    const trend = viewsTrend(
      overview("2026-10-01T00:00:00.000Z", "2026-10-08T00:00:00.000Z", [
        { date: "2026-10-02", platform: "threads", posts: 1, views: 300 },
        { date: "2026-10-02", platform: "instagram", posts: 2, views: 1_000 },
        { date: "2026-10-05", platform: "instagram", posts: 1, views: 500 },
        // Outside the range: ignored.
        { date: "2026-10-09", platform: "instagram", posts: 1, views: 9_999 },
      ]),
    );
    expect(trend.granularity).toBe("day");
    expect(trend.buckets).toHaveLength(7);
    expect(trend.lines.map((line) => line.platform)).toEqual(["instagram", "threads"]);
    const instagram = trend.lines[0]?.values ?? [];
    expect(instagram.map((value) => value.views)).toEqual([0, 1_000, 0, 0, 500, 0, 0]);
    expect(instagram.map((value) => value.total)).toEqual([
      0, 1_000, 1_000, 1_000, 1_500, 1_500, 1_500,
    ]);
    expect(trend.lines[1]?.values.at(-1)?.total).toBe(300);
    expect(trend.activeBuckets).toBe(2);
  });

  it("adds days into weeks", () => {
    const trend = viewsTrend(
      overview("2026-07-16T00:00:00.000Z", "2026-10-14T00:00:00.000Z", [
        { date: "2026-10-12", platform: "facebook", posts: 1, views: 100 },
        { date: "2026-10-13", platform: "facebook", posts: 2, views: 50 },
      ]),
    );
    expect(trend.granularity).toBe("week");
    expect(trend.lines[0]?.values.at(-1)).toEqual({ views: 150, posts: 3, total: 150 });
    expect(trend.activeBuckets).toBe(1);
  });

  it("rounds the value axis up to clean ticks from zero", () => {
    const y = valueScale(8_600, 200);
    expect(y.domain()).toEqual([0, 10_000]);
    expect(y(0)).toBe(200);
    expect(y(10_000)).toBe(0);
    expect(y.ticks(4)).toContain(0);
    // Nothing to show still draws an axis.
    expect(valueScale(0, 200).domain()).toEqual([0, 1]);
  });

  it("finds the nearest point and spaces tick labels", () => {
    expect(nearestIndex(0, 30, 290)).toBe(0);
    expect(nearestIndex(14, 30, 290)).toBe(1);
    expect(nearestIndex(1_000, 30, 290)).toBe(29);
    expect(nearestIndex(50, 1, 290)).toBe(0);
    expect(tickIndices(5, 600)).toEqual([0, 1, 2, 3, 4]);
    const many = tickIndices(30, 290, 64);
    expect(many[0]).toBe(0);
    expect(many.length).toBeLessThanOrEqual(5);
    expect(tickIndices(0, 300)).toEqual([]);
  });

  it("keeps bars thin with a gap between neighbours", () => {
    const few = barLayout(["a", "b", "c"], 600);
    expect(few.barWidth).toBe(24);
    const many = barLayout(
      Array.from({ length: 120 }, (_, index) => String(index)),
      600,
    );
    expect(many.barWidth).toBeLessThanOrEqual(many.step - 2);
    expect(many.x("1") - (many.x("0") + many.barWidth)).toBeGreaterThanOrEqual(2);
    expect(few.center("b") - few.x("b")).toBeCloseTo(12);
  });

  it("rounds the data end of a bar and leaves the base square", () => {
    const path = barPath(10, 20, 24, 100);
    expect(path.startsWith("M10,120V24A4,4")).toBe(true);
    expect(path).toContain("H30");
    expect(path.endsWith("V120Z")).toBe(true);
    // Short bars shrink the radius to fit; empty bars draw nothing.
    expect(barPath(0, 0, 24, 2)).toContain("A2,2");
    expect(barPath(0, 0, 24, 0)).toBe("");
  });
});

describe("analytics formatting", () => {
  it("formats counts, rates and watch time", () => {
    expect(formatCount(842)).toBe("842");
    expect(formatCount(12_904)).toBe("12.9K");
    expect(formatCount(4_200_000)).toBe("4.2M");
    expect(formatCount(null)).toBe(NO_VALUE);
    expect(formatFullCount(12_904)).toBe("12,904");
    expect(formatRate(0.0482)).toBe("4.8%");
    expect(formatRate(null)).toBe(NO_VALUE);
    expect(formatWatch(12_400)).toBe("12.4 s");
    expect(formatWatch(65_000)).toBe("1:05 min");
    expect(formatMetric("avgWatchMs", 9_000)).toBe("9.0 s");
    expect(formatMetric("views", 12_904, true)).toBe("12,904");
  });

  it("computes engagement from one capture", () => {
    const metrics = capture("2026-10-01T12:00:00.000Z", 24, 1_000, { saves: 10 });
    // 50 likes, 10 comments, 10 shares and 10 saves over 1,000 views.
    expect(engagementRate(metrics)).toBeCloseTo(0.08);
    expect(engagementRate({ ...metrics, views: 0 })).toBeNull();
    expect(engagementRate(null)).toBeNull();
  });

  it("keeps platform colours fixed whatever is on screen", () => {
    expect(platformColor("instagram")).toBe("var(--viz-2)");
    expect(orderPlatforms(["threads", "facebook", "threads"])).toEqual(["facebook", "threads"]);
  });

  it("writes tooltips with the value first and the same words as the table", () => {
    const trend = viewsTrend(
      overview("2026-10-01T00:00:00.000Z", "2026-10-04T00:00:00.000Z", [
        { date: "2026-10-02", platform: "instagram", posts: 2, views: 1_204 },
      ]),
    );
    const content = trendTooltip(trend, 1);
    expect(content).toEqual({
      title: "Oct 2",
      rows: [
        {
          id: "instagram",
          color: "var(--viz-2)",
          value: "1,204",
          label: "Instagram · +1,204 from 2 posts",
        },
      ],
    });
    expect(tooltipText(trendTooltip(trend, 2))).toBe("Oct 3: 1,204, Instagram · no posts");
    expect(tooltipText({ title: "Empty", rows: [] })).toBe("Empty");

    const post: PostPerformance = {
      ...mockLivePost({
        item: { id: "i", workspaceId: "p", seriesId: null, title: "Moves" },
        platform: "threads",
        publishedAt: "2026-10-02T12:00:00.000Z",
      }).post,
      metrics: capture("2026-10-02T12:00:00.000Z", 24, 1_500),
    };
    expect(tooltipText(postTooltip(post, "views"))).toBe(
      "Moves: 1,500 views, Threads · Oct 2, 2026",
    );
    expect(postMeasure(post, "avgWatchMs")).toBe("Not reported");
    expect(postMeasure({ ...post, metrics: null }, "views")).toBe("Not measured yet");

    const first = capture("2026-10-02T12:00:00.000Z", 1, 120);
    expect(captureTooltip(first, "views", "Views", "red").rows[0]?.value).toBe("120");
    expect(captureTooltip(first, "saves", "Saves", "red").rows[0]?.value).toBe("Not reported");
    expect(canSpark([first], "views")).toBe(false);
    expect(canSpark([first, capture("2026-10-02T12:00:00.000Z", 6, 400)], "views")).toBe(true);
    expect(canSpark([first, capture("2026-10-02T12:00:00.000Z", 6, 400)], "saves")).toBe(false);
  });
});

describe("analytics ranges", () => {
  it("covers whole UTC days ending with today", () => {
    const now = utc("2026-10-13T15:20:00Z");
    expect(rangeOfDays(30, now)).toEqual({
      from: "2026-09-14T00:00:00.000Z",
      to: "2026-10-14T00:00:00.000Z",
    });
    expect(seriesRange("all", now)).toEqual({});
    expect(seriesRange("90d", now)).toEqual(rangeOfDays(90, now));
  });

  it("drops unknown search values instead of failing", () => {
    expect(OverviewSearchSchema.parse({ range: "5y", workspace: "nope" })).toEqual({});
    expect(OverviewSearchSchema.parse({ range: "90d" })).toEqual({ range: "90d" });
  });
});

describe("mock analytics", () => {
  it("groups daily views by UTC publish day and ranks the top posts", () => {
    const item = { id: "i", workspaceId: "p", seriesId: null, title: "Late night" };
    // 23:30 at UTC-5 is the next day in UTC.
    const late = mockLivePost({
      item,
      platform: "instagram",
      publishedAt: "2026-10-03T04:30:00.000Z",
      history: [capture("2026-10-03T04:30:00.000Z", 24, 700)],
    });
    const early = mockLivePost({
      item,
      platform: "instagram",
      publishedAt: "2026-10-03T20:00:00.000Z",
      history: [capture("2026-10-03T20:00:00.000Z", 24, 300)],
    });
    const pending = mockLivePost({
      item,
      platform: "threads",
      publishedAt: "2026-10-04T08:00:00.000Z",
    });
    const result = overviewOf(
      [late, early, pending],
      "2026-10-01T00:00:00.000Z",
      "2026-10-08T00:00:00.000Z",
    );
    expect(result.daily).toEqual([
      { date: "2026-10-03", platform: "instagram", posts: 2, views: 1_000 },
      { date: "2026-10-04", platform: "threads", posts: 1, views: 0 },
    ]);
    expect(result.totals).toMatchObject({
      posts: 3,
      measuredPosts: 2,
      views: 1_000,
      medianViews: 500,
    });
    expect(result.topPosts.map((post) => post.metrics?.views ?? null)).toEqual([700, 300, null]);
    expect(result.platforms.map((entry) => entry.platform)).toEqual(["instagram", "threads"]);
  });
});
