import { z } from "zod";
import { AnalyticsAggregateSchema, PostMetricsSchema } from "../analytics/metrics";
import { IdSchema, TimestampSchema } from "../common";
import { PlatformSchema } from "../enums";
import { PermalinkSchema } from "../publishing/request";

// Analytics cover posts that went live: `published` and not dry-run. Dry-run posts have no
// insights. Every figure is computed from each post's latest capture with `aggregatePosts`.

/** The longest range one `analytics.overview` request may cover. */
export const MAX_ANALYTICS_RANGE_DAYS = 366;
export const MAX_ANALYTICS_RANGE_MS = MAX_ANALYTICS_RANGE_DAYS * 24 * 60 * 60_000;

/** How many posts the overview ranks in `topPosts`. */
export const ANALYTICS_TOP_POSTS = 10;

/** A published post with its latest capture; `metrics` is null until the first capture. */
export const PostPerformanceSchema = z.object({
  postId: IdSchema,
  itemId: IdSchema,
  projectId: IdSchema,
  seriesId: IdSchema.nullable(),
  channelId: IdSchema,
  platform: PlatformSchema,
  /** The item's title. */
  title: z.string(),
  permalink: PermalinkSchema.nullable(),
  publishedAt: TimestampSchema,
  metrics: PostMetricsSchema.nullable(),
});
export type PostPerformance = z.infer<typeof PostPerformanceSchema>;

/**
 * `GET /api/analytics/posts/:id`: one post, every capture oldest first (for sparklines), and when
 * the next capture is due (null once the insights schedule has run out).
 */
export const PostAnalyticsSchema = z.object({
  post: PostPerformanceSchema,
  history: z.array(PostMetricsSchema),
  nextCaptureAt: TimestampSchema.nullable(),
});
export type PostAnalytics = z.infer<typeof PostAnalyticsSchema>;

/** `GET /api/analytics/items/:id`: every live post of an item, one per channel, with totals. */
export const ItemAnalyticsSchema = z.object({
  itemId: IdSchema,
  totals: AnalyticsAggregateSchema,
  posts: z.array(PostAnalyticsSchema),
});
export type ItemAnalytics = z.infer<typeof ItemAnalyticsSchema>;

function checkOptionalRange(range: { from?: string; to?: string }, ctx: z.RefinementCtx): void {
  if (range.from === undefined || range.to === undefined) return;
  if (!(Date.parse(range.to) > Date.parse(range.from))) {
    ctx.addIssue({ code: "custom", message: "The range must end after it starts", path: ["to"] });
  }
}

/** `GET /api/analytics/series/:id`: posts published in `[from, to)`, or all of them. */
export const SeriesAnalyticsQuerySchema = z
  .object({
    from: TimestampSchema.optional(),
    to: TimestampSchema.optional(),
  })
  .superRefine(checkOptionalRange);
export type SeriesAnalyticsQuery = z.infer<typeof SeriesAnalyticsQuerySchema>;

/** A series' live posts, oldest `publishedAt` first, and their totals. */
export const SeriesAnalyticsSchema = z.object({
  seriesId: IdSchema,
  totals: AnalyticsAggregateSchema,
  posts: z.array(PostPerformanceSchema),
});
export type SeriesAnalytics = z.infer<typeof SeriesAnalyticsSchema>;

/**
 * `GET /api/analytics/overview`: posts published in `[from, to)`, at most
 * `MAX_ANALYTICS_RANGE_DAYS` long, optionally for one project.
 */
export const AnalyticsOverviewQuerySchema = z
  .object({
    from: TimestampSchema,
    to: TimestampSchema,
    projectId: IdSchema.optional(),
  })
  .superRefine((range, ctx) => {
    const span = Date.parse(range.to) - Date.parse(range.from);
    if (!(span > 0)) {
      ctx.addIssue({ code: "custom", message: "The range must end after it starts", path: ["to"] });
    } else if (span > MAX_ANALYTICS_RANGE_MS) {
      ctx.addIssue({
        code: "custom",
        message: `The range must not exceed ${MAX_ANALYTICS_RANGE_DAYS} days`,
        path: ["to"],
      });
    }
  });
export type AnalyticsOverviewQuery = z.infer<typeof AnalyticsOverviewQuerySchema>;

/** The totals of one platform's posts. */
export const PlatformAnalyticsSchema = z.object({
  platform: PlatformSchema,
  totals: AnalyticsAggregateSchema,
});
export type PlatformAnalytics = z.infer<typeof PlatformAnalyticsSchema>;

/**
 * The posts one platform published on one UTC day (`YYYY-MM-DD`) and their latest views. Days
 * without posts are left out.
 */
export const DailyViewsSchema = z.object({
  date: z.iso.date(),
  platform: PlatformSchema,
  posts: z.number().int().min(1),
  views: z.number().int().min(0),
});
export type DailyViews = z.infer<typeof DailyViewsSchema>;

/**
 * The overview of a range: totals, totals per platform (platforms without posts left out), daily
 * views per platform by publish day, oldest first, and the `ANALYTICS_TOP_POSTS` posts with the
 * most views, most first.
 */
export const AnalyticsOverviewSchema = z.object({
  from: TimestampSchema,
  to: TimestampSchema,
  totals: AnalyticsAggregateSchema,
  platforms: z.array(PlatformAnalyticsSchema),
  daily: z.array(DailyViewsSchema),
  topPosts: z.array(PostPerformanceSchema).max(ANALYTICS_TOP_POSTS),
});
export type AnalyticsOverview = z.infer<typeof AnalyticsOverviewSchema>;
