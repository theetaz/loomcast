import type { PostMetricCounts, PostMetrics } from "@loomcast/contracts";
import type { PostMetricsRow } from "@loomcast/db";

/** The counts of a capture, as `aggregatePosts` reads them. */
export function toMetricCounts(row: PostMetricsRow): PostMetricCounts {
  return {
    views: row.views,
    likes: row.likes,
    comments: row.comments,
    shares: row.shares,
    saves: row.saves,
    reach: row.reach,
    avgWatchMs: row.avgWatchMs,
  };
}

/** A `post_metrics` row as the contracts' `PostMetrics` (the raw answer stays on the server). */
export function toPostMetrics(row: PostMetricsRow): PostMetrics {
  return { capturedAt: row.capturedAt.toISOString(), ...toMetricCounts(row) };
}
