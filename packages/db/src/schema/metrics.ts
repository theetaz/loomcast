import type { JsonObject } from "@loomcast/contracts";
import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, timestamptz } from "./columns";
import { scheduledPosts } from "./posts";

/**
 * One capture of a published post's insights (the contracts' `PostMetrics`), appended on the
 * `insightsSchedule` after it went live. Each row is a snapshot of running totals, not a delta, so
 * the latest capture is the post's current performance: read it with `latestPostMetrics`, and the
 * history newest first through `post_metrics_post_id_captured_at_idx`.
 *
 * - **Counts** are null when the platform does not report the metric (such as Threads saves) and
 *   never negative (`post_metrics_counts_ck`). `avgWatchMs` is the average watch time per view.
 * - **`raw`** keeps the platform's answer as received, for metrics without a column. Remove every
 *   credential first: paging links in a Graph API answer carry an access token.
 * - Deleting the post deletes its captures.
 */
export const postMetrics = pgTable(
  "post_metrics",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    postId: uuid("post_id")
      .notNull()
      .references(() => scheduledPosts.id, { onDelete: "cascade" }),
    capturedAt: timestamptz("captured_at").notNull().defaultNow(),
    views: bigint("views", { mode: "number" }),
    likes: bigint("likes", { mode: "number" }),
    comments: bigint("comments", { mode: "number" }),
    shares: bigint("shares", { mode: "number" }),
    saves: bigint("saves", { mode: "number" }),
    reach: bigint("reach", { mode: "number" }),
    avgWatchMs: integer("avg_watch_ms"),
    raw: jsonb("raw").$type<JsonObject>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    index("post_metrics_post_id_captured_at_idx").on(t.postId, t.capturedAt.desc().nullsFirst()),
    check(
      "post_metrics_counts_ck",
      sql.join(
        [t.views, t.likes, t.comments, t.shares, t.saves, t.reach, t.avgWatchMs].map(
          (count) => sql`coalesce(${count}, 0) >= 0`,
        ),
        sql` and `,
      ),
    ),
    check("post_metrics_raw_ck", sql`jsonb_typeof(${t.raw}) = 'object'`),
  ],
);

export type PostMetricsRow = typeof postMetrics.$inferSelect;
export type NewPostMetricsRow = typeof postMetrics.$inferInsert;
