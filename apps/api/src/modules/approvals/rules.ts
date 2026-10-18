import { isPublishable, OPEN_POST_STATUSES } from "@loomcast/contracts";
import { type Database, scheduledPosts } from "@loomcast/db";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import type { ContentStateChange, EventBus } from "../../lib/bus";
import { type Transaction, transaction } from "../../lib/db";
import {
  APPROVED_ITEM_STATES,
  enqueuePublish,
  loadScheduledPosts,
  lockItemPosts,
  publishPostsUpdated,
  touchedAt,
} from "../calendar/posts";
import { type ContentService, type PipelineActor, SYSTEM_ACTOR } from "../content";
import { findVersion, lockItem } from "../content/queries";
import type { ReviewsService } from "../reviews/service";
import type { Scheduler } from "../scheduler";

// The approval rules tie an item's state to its posts:
//
// - Entering `review`: when every planned post of the item publishes in `auto` mode, the system
//   approves the rendered version (a system review, `auto_approve`).
// - Entering `approved` (a review decision, auto-approval, or a caption edit of an approved item):
//   planned posts become `queued` with the approved version, queued posts follow the new version,
//   each gets its publish task, and the item moves on to `scheduled` (system `schedule`).
// - Leaving `approved` or `scheduled` back into production: queued posts return to `planned` and
//   lose their version, so no unapproved version is ever published. The move into `scheduled`
//   and on to `published` keeps them. A person unscheduling an item does the same.
// - Archived: the item's open posts are cancelled.

export interface ApprovalRulesDeps {
  db: Database;
  bus: EventBus;
  scheduler: Pick<Scheduler, "enqueue">;
  content: Pick<ContentService, "transition">;
  reviews: Pick<ReviewsService, "create">;
}

export interface ApprovalRules {
  /** Applies the rules to a committed state change (`content.item.state_changed`). */
  onStateChanged(change: ContentStateChange): Promise<void>;
  /**
   * Approves an item in review on the user's behalf when every planned post is `auto`, then
   * queues the posts. True when it approved.
   */
  autoApprove(itemId: string): Promise<boolean>;
  /**
   * For an `approved` item: queues its planned posts with the current version, moves queued posts
   * to it, and (when any post is queued) moves the item to `scheduled` as `actor`. Returns the ids
   * of the posts it changed.
   */
  queueApproved(tx: Transaction, itemId: string, actor?: PipelineActor): Promise<string[]>;
}

export function createApprovalRules(deps: ApprovalRulesDeps): ApprovalRules {
  const { db, bus, scheduler, content, reviews } = deps;

  async function queueApproved(
    tx: Transaction,
    itemId: string,
    actor: PipelineActor = SYSTEM_ACTOR,
  ): Promise<string[]> {
    const item = await lockItem(tx, itemId);
    if (item === null || item.state !== "approved") {
      return [];
    }
    const changed = await tx
      .update(scheduledPosts)
      .set({ status: "queued", versionId: item.currentVersionId, updatedAt: touchedAt })
      .where(
        and(
          eq(scheduledPosts.itemId, itemId),
          or(
            eq(scheduledPosts.status, "planned"),
            and(
              eq(scheduledPosts.status, "queued"),
              sql`${scheduledPosts.versionId} is distinct from ${item.currentVersionId}`,
            ),
          ),
        ),
      )
      .returning({ id: scheduledPosts.id, scheduledAt: scheduledPosts.scheduledAt });
    for (const post of changed) {
      await enqueuePublish(tx, scheduler, post);
    }
    if (await hasQueuedPost(tx, itemId)) {
      await content.transition(tx, itemId, "scheduled", actor, { via: "schedule" });
    }
    const ids = changed.map((post) => post.id);
    await publishPostsUpdated(tx, bus, ids);
    return ids;
  }

  /** Queued posts of the item go back to `planned` without a version. */
  async function returnToPlanned(tx: Transaction, itemId: string): Promise<void> {
    const changed = await tx
      .update(scheduledPosts)
      .set({ status: "planned", versionId: null, updatedAt: touchedAt })
      .where(and(eq(scheduledPosts.itemId, itemId), eq(scheduledPosts.status, "queued")))
      .returning({ id: scheduledPosts.id });
    await publishPostsUpdated(
      tx,
      bus,
      changed.map((post) => post.id),
    );
  }

  async function cancelOpen(tx: Transaction, itemId: string): Promise<void> {
    const changed = await tx
      .update(scheduledPosts)
      .set({ status: "cancelled", updatedAt: touchedAt })
      .where(
        and(
          eq(scheduledPosts.itemId, itemId),
          inArray(scheduledPosts.status, [...OPEN_POST_STATUSES]),
        ),
      )
      .returning({ id: scheduledPosts.id });
    await publishPostsUpdated(
      tx,
      bus,
      changed.map((post) => post.id),
    );
  }

  async function autoApprove(itemId: string): Promise<boolean> {
    return transaction(db, async (tx) => {
      const item = await lockItem(tx, itemId);
      if (item === null || item.state !== "review") {
        return false;
      }
      const planned = await lockItemPosts(tx, itemId, ["planned"]);
      if (planned.length === 0) {
        return false;
      }
      const posts = await loadScheduledPosts(
        tx,
        planned.map((post) => post.id),
      );
      if (posts.length === 0 || posts.some((post) => post.publishMode !== "auto")) {
        return false;
      }
      const version = await findVersion(tx, item.id, item.currentVersionId);
      if (version === null || !isPublishable(version)) {
        return false;
      }
      await reviews.create(
        itemId,
        { versionId: item.currentVersionId, decision: "approve" },
        SYSTEM_ACTOR,
        { tx },
      );
      await queueApproved(tx, itemId);
      return true;
    });
  }

  async function onStateChanged(change: ContentStateChange): Promise<void> {
    const { itemId, from, to, via } = change;
    if (to === "review" && from !== "review") {
      await autoApprove(itemId);
      return;
    }
    if (to === "approved") {
      await transaction(db, async (tx) => {
        if (via !== "unschedule") {
          await queueApproved(tx, itemId);
          return;
        }
        // The system unschedules an item only once no post is queued. A person unschedules to
        // edit it: its posts wait as planned until it is approved again.
        if (change.actor.kind !== "system") {
          const item = await lockItem(tx, itemId);
          if (item?.state === "approved") await returnToPlanned(tx, itemId);
        }
      });
      return;
    }
    if (to === "archived") {
      await transaction(db, async (tx) => {
        const item = await lockItem(tx, itemId);
        if (item?.state === "archived") await cancelOpen(tx, itemId);
      });
      return;
    }
    if ((from === "approved" || from === "scheduled") && !APPROVED_ITEM_STATES.includes(to)) {
      await transaction(db, async (tx) => {
        const item = await lockItem(tx, itemId);
        if (item !== null && !APPROVED_ITEM_STATES.includes(item.state)) {
          await returnToPlanned(tx, itemId);
        }
      });
    }
  }

  return { onStateChanged, autoApprove, queueApproved };
}

/** Whether some post of the item is still `queued`. */
export async function hasQueuedPost(tx: Transaction, itemId: string): Promise<boolean> {
  const [row] = await tx
    .select({ one: sql<number>`1` })
    .from(scheduledPosts)
    .where(and(eq(scheduledPosts.itemId, itemId), eq(scheduledPosts.status, "queued")))
    .limit(1);
  return row !== undefined;
}
