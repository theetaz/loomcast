import { insightsSchedule } from "@loomcast/contracts";
import type { Transaction } from "../../lib/db";
import type { LivePublishedPost } from "../publisher/tasks";
import type { Scheduler } from "../scheduler";
import { supportsInsights } from "./normalize";

/** Dedupe key of a post's `insights.pull` task for the `index`th time of its schedule. */
export function insightsDedupeKey(postId: string, index: number): string {
  return `insights:${postId}:${index}`;
}

/**
 * Enqueues one `insights.pull` task per time of `insightsSchedule(publishedAt)`, in the
 * transaction that marks the post published. Platforms without insights get none. Returns the
 * times enqueued.
 */
export async function enqueueInsightsPulls(
  scheduler: Pick<Scheduler, "enqueue">,
  tx: Transaction,
  post: Pick<LivePublishedPost, "postId" | "platform" | "publishedAt">,
): Promise<Date[]> {
  if (!supportsInsights(post.platform)) {
    return [];
  }
  const times = insightsSchedule(post.publishedAt);
  for (const [index, runAt] of times.entries()) {
    await scheduler.enqueue(
      tx,
      "insights.pull",
      { postId: post.postId },
      { runAt, dedupeKey: insightsDedupeKey(post.postId, index), onDuplicate: "keep" },
    );
  }
  return times;
}
