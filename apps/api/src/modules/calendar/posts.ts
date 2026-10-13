import type { PipelineState, PublishingMode, ScheduledPost } from "@loomcast/contracts";
import { type ScheduledPostRow, scheduledPosts } from "@loomcast/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { EventBus } from "../../lib/bus";
import { afterCommit, type Transaction } from "../../lib/db";
import { loadScheduledPosts } from "../publisher/posts";
import type { Scheduler } from "../scheduler";

// The small writes on scheduled posts the calendar, the cadence planner and the approval rules
// share. Posts are mapped for responses and events by the publisher's `loadScheduledPosts`.

export { loadScheduledPost, loadScheduledPosts, toScheduledPost } from "../publisher/posts";

/** Item states whose current version has been approved, so its posts may be `queued`. */
export const APPROVED_ITEM_STATES: readonly PipelineState[] = [
  "approved",
  "scheduled",
  "published",
];

/**
 * `updated_at` for a post write: the wall clock to the millisecond, and always at least a
 * millisecond after the previous value, so a client's `expectedUpdatedAt` (millisecond ISO text)
 * goes stale on every change.
 */
export const touchedAt = sql<Date>`greatest(date_trunc('milliseconds', clock_timestamp()), ${scheduledPosts.updatedAt} + interval '1 millisecond')`;

/** Dedupe key of a post's publish task. */
export function publishTaskKey(postId: string): string {
  return `publish:${postId}`;
}

/** Whether a new post publishes in dry-run: the channel's switch or the server's mode. */
export function newPostDryRun(channel: { dryRun: boolean }, mode: PublishingMode): boolean {
  return channel.dryRun || mode === "dry-run";
}

/** Posts in time order (then by id), the order every list of the calendar uses. */
export function byScheduledAt(a: ScheduledPost, b: ScheduledPost): number {
  return a.scheduledAt.localeCompare(b.scheduledAt) || a.id.localeCompare(b.id);
}

/**
 * Maps the posts now, inside the transaction, and publishes `post.updated` for each once it
 * commits. Returns the mapped posts.
 */
export async function publishPostsUpdated(
  tx: Transaction,
  bus: EventBus,
  ids: readonly string[],
): Promise<ScheduledPost[]> {
  const posts = (await loadScheduledPosts(tx, [...new Set(ids)])).sort(byScheduledAt);
  if (posts.length > 0) {
    afterCommit(tx, () => {
      for (const post of posts) {
        bus.publish({ type: "post.updated", payload: { post } });
      }
    });
  }
  return posts;
}

/**
 * Queues (or moves) the post's `post.publish` task to its time, under `publish:<postId>`. A
 * pending task with that key moves to the new time; the publisher settles planned, cancelled and
 * finished posts when the task runs.
 */
export async function enqueuePublish(
  tx: Transaction,
  scheduler: Pick<Scheduler, "enqueue">,
  post: { id: string; scheduledAt: Date },
): Promise<void> {
  await scheduler.enqueue(
    tx,
    "post.publish",
    { postId: post.id },
    { runAt: post.scheduledAt, dedupeKey: publishTaskKey(post.id) },
  );
}

/** The posts of an item in these statuses, locked for update. */
export async function lockItemPosts(
  tx: Transaction,
  itemId: string,
  statuses: readonly ScheduledPostRow["status"][],
): Promise<ScheduledPostRow[]> {
  if (statuses.length === 0) {
    return [];
  }
  return tx
    .select()
    .from(scheduledPosts)
    .where(and(eq(scheduledPosts.itemId, itemId), inArray(scheduledPosts.status, [...statuses])))
    .orderBy(scheduledPosts.scheduledAt, scheduledPosts.id)
    .for("update");
}
