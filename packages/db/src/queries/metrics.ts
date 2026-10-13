import { desc, inArray } from "drizzle-orm";
import type { Database } from "../client";
import { type PostMetricsRow, postMetrics } from "../schema";

/** Anything with the select builder: a transaction, or the database. */
export type MetricsExecutor = Pick<Database, "selectDistinctOn">;

/**
 * The latest capture of each post in `postIds`, ordered by post id, through
 * `post_metrics_post_id_captured_at_idx`. A post without a capture has no entry; `aggregatePosts`
 * wants `null` for it. Captures with the same `captured_at` resolve to the one inserted last.
 */
export async function latestPostMetrics(
  db: MetricsExecutor,
  postIds: readonly string[],
): Promise<PostMetricsRow[]> {
  if (postIds.length === 0) return [];
  return db
    .selectDistinctOn([postMetrics.postId])
    .from(postMetrics)
    .where(inArray(postMetrics.postId, [...postIds]))
    .orderBy(postMetrics.postId, desc(postMetrics.capturedAt), desc(postMetrics.id));
}
