import { z } from "zod";
import { TimestampSchema } from "../common";

// Post metrics are captured from the platforms' insights on a decaying schedule after a post goes
// live. Each capture is a snapshot of running totals, not a delta: the latest capture is the post's
// current performance.

/** A running total the platform reports for a post; null when it does not report that metric. */
const MetricCountSchema = z.number().int().min(0).nullable();

/**
 * One capture of a post's insights. Counts are totals since the post went live. A platform that
 * does not report a metric (such as Threads saves) leaves it null rather than 0. `avgWatchMs` is
 * the average watch time per view, where the platform reports it.
 */
export const PostMetricsSchema = z.object({
  capturedAt: TimestampSchema,
  views: MetricCountSchema,
  likes: MetricCountSchema,
  comments: MetricCountSchema,
  shares: MetricCountSchema,
  saves: MetricCountSchema,
  reach: MetricCountSchema,
  avgWatchMs: MetricCountSchema,
});
export type PostMetrics = z.infer<typeof PostMetricsSchema>;

/** The counts `aggregatePosts` reads from a capture. */
export type PostMetricCounts = Pick<
  PostMetrics,
  "views" | "likes" | "comments" | "shares" | "saves" | "reach" | "avgWatchMs"
>;

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * When insights are captured, after the time a post went live: 1 h, 6 h, 24 h, 72 h, 7 days,
 * 14 days and 30 days. Early captures follow the first surge; later ones settle the totals.
 */
export const INSIGHTS_SCHEDULE_OFFSETS_MS = [
  HOUR_MS,
  6 * HOUR_MS,
  24 * HOUR_MS,
  72 * HOUR_MS,
  7 * DAY_MS,
  14 * DAY_MS,
  30 * DAY_MS,
] as const;

/**
 * The times to pull a post's insights, in order: `publishedAt` plus each of
 * `INSIGHTS_SCHEDULE_OFFSETS_MS`. Throws a `RangeError` for an invalid time.
 */
export function insightsSchedule(publishedAt: Date | string): Date[] {
  const start = typeof publishedAt === "string" ? Date.parse(publishedAt) : publishedAt.getTime();
  if (!Number.isFinite(start)) throw new RangeError("Invalid publish time");
  return INSIGHTS_SCHEDULE_OFFSETS_MS.map((offset) => new Date(start + offset));
}

/**
 * Totals over a set of published posts.
 * - `posts`: the posts counted; `measuredPosts`: those with at least one capture.
 * - `views` to `reach`: sums of each post's latest capture, counting a metric the platform does not
 *   report as 0. `reach` adds up per-post reach, so one person reached by two posts counts twice.
 * - `medianViews`: the median of the posts that report views; null when none does.
 * - `engagementRate`: `(likes + comments + shares + saves) / views`; null while `views` is 0.
 * - `avgWatchMs`: the average watch time per view, weighted by each post's views, over the posts
 *   that report both; null when none does.
 */
export const AnalyticsAggregateSchema = z.object({
  posts: z.number().int().min(0),
  measuredPosts: z.number().int().min(0),
  views: z.number().int().min(0),
  likes: z.number().int().min(0),
  comments: z.number().int().min(0),
  shares: z.number().int().min(0),
  saves: z.number().int().min(0),
  reach: z.number().int().min(0),
  medianViews: z.number().min(0).nullable(),
  engagementRate: z.number().min(0).nullable(),
  avgWatchMs: z.number().int().min(0).nullable(),
});
export type AnalyticsAggregate = z.infer<typeof AnalyticsAggregateSchema>;

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle] ?? 0;
  return sorted.length % 2 === 1 ? upper : ((sorted[middle - 1] ?? 0) + upper) / 2;
}

/**
 * Aggregates the latest capture of each post (`AnalyticsAggregate`). Pass one entry per published
 * post, `null` for a post without a capture yet, so it counts in `posts` but adds nothing else.
 */
export function aggregatePosts(latest: readonly (PostMetricCounts | null)[]): AnalyticsAggregate {
  const totals = { views: 0, likes: 0, comments: 0, shares: 0, saves: 0, reach: 0 };
  const views: number[] = [];
  let measuredPosts = 0;
  let watchedViews = 0;
  let watchTotalMs = 0;

  for (const metrics of latest) {
    if (metrics === null) continue;
    measuredPosts += 1;
    totals.views += metrics.views ?? 0;
    totals.likes += metrics.likes ?? 0;
    totals.comments += metrics.comments ?? 0;
    totals.shares += metrics.shares ?? 0;
    totals.saves += metrics.saves ?? 0;
    totals.reach += metrics.reach ?? 0;
    if (metrics.views !== null) views.push(metrics.views);
    if (metrics.avgWatchMs !== null && metrics.views !== null && metrics.views > 0) {
      watchedViews += metrics.views;
      watchTotalMs += metrics.avgWatchMs * metrics.views;
    }
  }

  const engagements = totals.likes + totals.comments + totals.shares + totals.saves;
  return {
    posts: latest.length,
    measuredPosts,
    ...totals,
    medianViews: median(views),
    engagementRate: totals.views > 0 ? engagements / totals.views : null,
    avgWatchMs: watchedViews > 0 ? Math.round(watchTotalMs / watchedViews) : null,
  };
}
