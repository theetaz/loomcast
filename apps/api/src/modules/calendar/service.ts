import {
  type CalendarQuery,
  type CalendarResponse,
  type CreatePostRequest,
  MIN_SCHEDULE_LEAD_MS,
  OPEN_POST_STATUSES,
  PLATFORM_LABELS,
  type Platform,
  POST_FORMAT_LABELS,
  type PostFormat,
  type PublishingMode,
  platformRefusal,
  RESCHEDULABLE_POST_STATUSES,
  type ReschedulePostRequest,
  type ScheduledPost,
} from "@loomcast/contracts";
import {
  type ContentItemRow,
  channels,
  contentItems,
  contentVersions,
  type Database,
  type ScheduledPostRow,
  scheduledPosts,
  scheduledTasks,
} from "@loomcast/db";
import { and, asc, eq, gte, inArray, lt, min, sql } from "drizzle-orm";
import { audit } from "../../lib/audit";
import type { EventBus } from "../../lib/bus";
import type { Clock } from "../../lib/clock";
import type { Transaction } from "../../lib/db";
import { conflict, HttpError, notFound, validationFailed } from "../../lib/errors";
import { hasQueuedPost } from "../approvals/rules";
import { produceAt, produceTaskKey } from "../cadence/plan";
import { auditActor, type ContentService, type PipelineActor, SYSTEM_ACTOR } from "../content";
import { lockItem } from "../content/queries";
import { inTransaction, invalidTransition } from "../content/support";
import type { Scheduler } from "../scheduler";
import {
  APPROVED_ITEM_STATES,
  byScheduledAt,
  enqueuePublish,
  loadScheduledPosts,
  newPostDryRun,
  publishPostsUpdated,
  touchedAt,
} from "./posts";
import { listSlots, loadSeriesPlans } from "./slots";

// The calendar: posts and open slots in a range, and the moves a person makes on it. Scheduling an
// approved item creates a queued post and its publish task; planning an item still in review
// creates a planned post, which the approval rules queue once the item is approved; rescheduling
// moves the post and its task; cancelling withdraws it. An item whose last queued post is
// cancelled goes back from `scheduled` to `approved`.

export interface CalendarServiceDeps {
  db: Database;
  bus: EventBus;
  clock: Clock;
  scheduler: Pick<Scheduler, "enqueue">;
  content: Pick<ContentService, "transition">;
  config: { publishing: { mode: PublishingMode } };
}

export interface CalendarService {
  get(query: CalendarQuery): Promise<CalendarResponse>;
  /**
   * Schedules an approved item on a channel. With `options.tx` it runs in the caller's
   * transaction, so several posts (and the approval before them) commit or fail together.
   */
  create(
    input: CreatePostRequest,
    actor: PipelineActor,
    options?: { tx?: Transaction },
  ): Promise<ScheduledPost>;
  /**
   * Plans an item that is not approved yet on a channel: a `planned` post without a version, which
   * becomes `queued` when the item is approved and is `missed` if its time comes first. The same
   * checks as `create` apply, except the item's state; an archived item is refused.
   */
  plan(
    input: CreatePostRequest,
    actor: PipelineActor,
    options?: { tx?: Transaction },
  ): Promise<ScheduledPost>;
  /** With `options.tx`, runs in the caller's transaction. */
  reschedule(
    id: string,
    input: ReschedulePostRequest,
    actor: PipelineActor,
    options?: { tx?: Transaction },
  ): Promise<ScheduledPost>;
  /** With `options.tx`, runs in the caller's transaction. */
  cancel(id: string, actor: PipelineActor, options?: { tx?: Transaction }): Promise<ScheduledPost>;
}

const postNotFound = () => notFound("No scheduled post has that id.");

function postNotEditable(status: ScheduledPostRow["status"]): HttpError {
  return new HttpError(
    409,
    "post_not_editable",
    "This post is publishing, published or cancelled and cannot change.",
    { status },
  );
}

/** 422 when a channel's platform does not publish the item's post format. */
export function formatNotSupported(
  platform: Platform,
  format: PostFormat,
  message = `${PLATFORM_LABELS[platform]} does not publish ${POST_FORMAT_LABELS[format].toLowerCase()}s.`,
): HttpError {
  return new HttpError(422, "format_not_supported", message, { platform, format });
}

function isReschedulable(status: ScheduledPostRow["status"]): boolean {
  return (RESCHEDULABLE_POST_STATUSES as readonly string[]).includes(status);
}

export function createCalendarService(deps: CalendarServiceDeps): CalendarService {
  const { db, bus, clock, scheduler, content } = deps;

  /** 400 unless `at` is at least `MIN_SCHEDULE_LEAD_MS` ahead. */
  function requireLead(at: string): Date {
    const when = new Date(at);
    if (when.getTime() < clock.now().getTime() + MIN_SCHEDULE_LEAD_MS) {
      throw validationFailed([
        { path: "scheduledAt", message: "Pick a time at least two minutes ahead" },
      ]);
    }
    return when;
  }

  /**
   * The post and its item, both locked. The item is locked first, in the same order as every
   * other writer of an item and its posts (the approval rules, the planner), so they never
   * deadlock.
   */
  async function lockPost(
    tx: Transaction,
    id: string,
  ): Promise<{ row: ScheduledPostRow; item: ContentItemRow }> {
    const [peek] = await tx
      .select({ itemId: scheduledPosts.itemId })
      .from(scheduledPosts)
      .where(eq(scheduledPosts.id, id))
      .limit(1);
    const item = peek === undefined ? null : await lockItem(tx, peek.itemId);
    const [row] = await tx
      .select()
      .from(scheduledPosts)
      .where(eq(scheduledPosts.id, id))
      .limit(1)
      .for("update");
    if (row === undefined || item === null) {
      throw postNotFound();
    }
    return { row, item };
  }

  async function mapped(tx: Transaction, id: string): Promise<ScheduledPost> {
    const [post] = await publishPostsUpdated(tx, bus, [id]);
    if (post === undefined) {
      throw new Error("scheduled post vanished");
    }
    return post;
  }

  /** A `scheduled` item with no queued post left goes back to `approved`. */
  async function settleScheduled(tx: Transaction, itemId: string): Promise<void> {
    const item = await lockItem(tx, itemId);
    if (item?.state === "scheduled" && !(await hasQueuedPost(tx, itemId))) {
      await content.transition(tx, itemId, "approved", SYSTEM_ACTOR, { via: "unschedule" });
    }
  }

  /**
   * Moves the item's pending production task with its earliest open post, so an idea moved
   * earlier is still produced `leadTimeHours` ahead.
   */
  async function moveProduceTask(tx: Transaction, itemId: string, seriesId: string | null) {
    if (seriesId === null) return;
    const [pending] = await tx
      .select({ id: scheduledTasks.id, runAt: scheduledTasks.runAt })
      .from(scheduledTasks)
      .where(
        and(
          eq(scheduledTasks.kind, "cadence.produce"),
          eq(scheduledTasks.status, "pending"),
          eq(scheduledTasks.dedupeKey, produceTaskKey(itemId)),
        ),
      );
    if (pending === undefined) return;
    const [earliest] = await tx
      .select({ at: min(scheduledPosts.scheduledAt) })
      .from(scheduledPosts)
      .where(
        and(
          eq(scheduledPosts.itemId, itemId),
          inArray(scheduledPosts.status, [...OPEN_POST_STATUSES]),
        ),
      );
    const [plan] = await loadSeriesPlans(tx, { seriesIds: [seriesId] });
    if (earliest?.at == null || plan === undefined) return;
    const runAt = produceAt(plan, earliest.at, clock.now());
    if (runAt.getTime() === pending.runAt.getTime()) return;
    await scheduler.enqueue(
      tx,
      "cadence.produce",
      { itemId },
      { runAt, dedupeKey: produceTaskKey(itemId) },
    );
  }

  /**
   * The channel of a new post, checked against the item's current version: it exists, is not
   * disabled, and its platform publishes the version's format.
   */
  async function postChannel(tx: Transaction, channelId: string) {
    const [channel] = await tx
      .select({
        id: channels.id,
        platform: channels.platform,
        status: channels.status,
        dryRun: channels.dryRun,
      })
      .from(channels)
      .where(eq(channels.id, channelId))
      .limit(1);
    if (channel === undefined) {
      throw notFound("No channel has that id.");
    }
    return channel;
  }

  async function requireChannelFits(
    tx: Transaction,
    item: ContentItemRow,
    channel: { platform: Platform; status: string },
  ): Promise<void> {
    if (channel.status === "disabled") {
      throw conflict("The channel is disabled.", { reason: "channel_disabled" });
    }
    const [version] = await tx
      .select({ format: contentVersions.format, media: contentVersions.media })
      .from(contentVersions)
      .where(eq(contentVersions.id, item.currentVersionId))
      .limit(1);
    const format = version?.format ?? "reel";
    const refusal = platformRefusal(channel.platform, { format, media: version?.media ?? [] });
    if (refusal !== null) {
      throw formatNotSupported(channel.platform, format, refusal);
    }
  }

  /** 409 `conflict` (`reason: "duplicate"`) naming the item's open post on the channel. */
  async function duplicatePost(tx: Transaction, itemId: string, channelId: string) {
    const [existing] = await tx
      .select({ id: scheduledPosts.id, status: scheduledPosts.status })
      .from(scheduledPosts)
      .where(
        and(
          eq(scheduledPosts.itemId, itemId),
          eq(scheduledPosts.channelId, channelId),
          sql`${scheduledPosts.status} <> 'cancelled'`,
        ),
      );
    return conflict("This item already has a post on that channel.", {
      reason: "duplicate",
      ...(existing === undefined ? {} : { postId: existing.id, status: existing.status }),
    });
  }

  return {
    async get(query) {
      const from = new Date(query.from);
      const to = new Date(query.to);
      const rows = await db
        .select({ id: scheduledPosts.id })
        .from(scheduledPosts)
        .innerJoin(contentItems, eq(contentItems.id, scheduledPosts.itemId))
        .where(
          and(
            gte(scheduledPosts.scheduledAt, from),
            lt(scheduledPosts.scheduledAt, to),
            query.projectId === undefined ? undefined : eq(contentItems.projectId, query.projectId),
            query.seriesIds === undefined
              ? undefined
              : inArray(scheduledPosts.seriesId, query.seriesIds),
            query.channelIds === undefined
              ? undefined
              : inArray(scheduledPosts.channelId, query.channelIds),
          ),
        )
        .orderBy(asc(scheduledPosts.scheduledAt), asc(scheduledPosts.id));
      const posts = (
        await loadScheduledPosts(
          db,
          rows.map((row) => row.id),
        )
      ).sort(byScheduledAt);
      // Slots from now on: past slots are history, not openings.
      const slotsFrom = new Date(Math.max(from.getTime(), clock.now().getTime()));
      const slots = await listSlots(db, {
        from: slotsFrom,
        to,
        ...(query.projectId === undefined ? {} : { projectId: query.projectId }),
        ...(query.seriesIds === undefined ? {} : { seriesIds: query.seriesIds }),
        ...(query.channelIds === undefined ? {} : { channelIds: query.channelIds }),
      });
      return { posts, slots };
    },

    async create(input, actor, options = {}) {
      return inTransaction(db, options.tx, async (tx) => {
        const item = await lockItem(tx, input.itemId);
        if (item === null) {
          throw notFound("No content item has that id.");
        }
        const channel = await postChannel(tx, input.channelId);
        if (!APPROVED_ITEM_STATES.includes(item.state)) {
          throw invalidTransition(item.state, "scheduled", "Only approved items can be scheduled.");
        }
        await requireChannelFits(tx, item, channel);
        const scheduledAt = requireLead(input.scheduledAt);
        const [post] = await tx
          .insert(scheduledPosts)
          .values({
            itemId: item.id,
            versionId: item.currentVersionId,
            channelId: channel.id,
            seriesId: item.seriesId,
            scheduledAt,
            status: "queued",
            dryRun: newPostDryRun(channel, deps.config.publishing.mode),
            options: input.options ?? {},
          })
          .onConflictDoNothing({
            target: [scheduledPosts.itemId, scheduledPosts.channelId],
            where: sql`${scheduledPosts.status} <> 'cancelled'`,
          })
          .returning();
        if (post === undefined) {
          throw await duplicatePost(tx, item.id, channel.id);
        }
        await enqueuePublish(tx, scheduler, post);
        await audit(tx, {
          ...auditActor(actor),
          action: "post.scheduled",
          targetType: "scheduled_post",
          targetId: post.id,
          data: {
            itemId: item.id,
            channelId: channel.id,
            scheduledAt: scheduledAt.toISOString(),
          },
        });
        if (item.state === "approved") {
          await content.transition(tx, item.id, "scheduled", actor, { via: "schedule" });
        }
        return mapped(tx, post.id);
      });
    },

    async plan(input, actor, options = {}) {
      return inTransaction(db, options.tx, async (tx) => {
        const item = await lockItem(tx, input.itemId);
        if (item === null) {
          throw notFound("No content item has that id.");
        }
        const channel = await postChannel(tx, input.channelId);
        if (item.state === "archived") {
          throw invalidTransition(item.state, "scheduled", "Archived items cannot be planned.");
        }
        await requireChannelFits(tx, item, channel);
        const scheduledAt = requireLead(input.scheduledAt);
        const [post] = await tx
          .insert(scheduledPosts)
          .values({
            itemId: item.id,
            channelId: channel.id,
            seriesId: item.seriesId,
            scheduledAt,
            status: "planned",
            dryRun: newPostDryRun(channel, deps.config.publishing.mode),
            options: input.options ?? {},
          })
          .onConflictDoNothing({
            target: [scheduledPosts.itemId, scheduledPosts.channelId],
            where: sql`${scheduledPosts.status} <> 'cancelled'`,
          })
          .returning();
        if (post === undefined) {
          throw await duplicatePost(tx, item.id, channel.id);
        }
        // At its time the publisher marks a post still planned as missed.
        await enqueuePublish(tx, scheduler, post);
        await audit(tx, {
          ...auditActor(actor),
          action: "post.planned",
          targetType: "scheduled_post",
          targetId: post.id,
          data: {
            itemId: item.id,
            channelId: channel.id,
            scheduledAt: scheduledAt.toISOString(),
          },
        });
        return mapped(tx, post.id);
      });
    },

    async reschedule(id, input, actor, options = {}) {
      return inTransaction(db, options.tx, async (tx) => {
        const { row, item } = await lockPost(tx, id);
        if (!isReschedulable(row.status)) {
          throw postNotEditable(row.status);
        }
        if (row.updatedAt.getTime() !== Date.parse(input.expectedUpdatedAt)) {
          throw conflict("The post changed since you loaded it. Reload it and try again.", {
            reason: "stale",
            updatedAt: row.updatedAt.toISOString(),
          });
        }
        const scheduledAt = requireLead(input.scheduledAt);
        // The post waits for its new time: queued with the current version when the item is
        // approved (a failed, missed or planned post included), planned without one otherwise.
        const approved = APPROVED_ITEM_STATES.includes(item.state);
        const status = approved ? "queued" : "planned";
        const versionId = approved ? item.currentVersionId : null;
        const [updated] = await tx
          .update(scheduledPosts)
          .set({
            scheduledAt,
            status,
            versionId,
            ...(status === row.status ? {} : { lastError: null }),
            updatedAt: touchedAt,
          })
          .where(eq(scheduledPosts.id, id))
          .returning();
        if (updated === undefined) {
          throw postNotFound();
        }
        await enqueuePublish(tx, scheduler, updated);
        await audit(tx, {
          ...auditActor(actor),
          action: "post.rescheduled",
          targetType: "scheduled_post",
          targetId: id,
          data: {
            from: row.scheduledAt.toISOString(),
            to: scheduledAt.toISOString(),
            status: updated.status,
          },
        });
        if (updated.status === "queued" && item.state === "approved") {
          await content.transition(tx, item.id, "scheduled", actor, { via: "schedule" });
        }
        await moveProduceTask(tx, item.id, item.seriesId);
        return mapped(tx, id);
      });
    },

    async cancel(id, actor, options = {}) {
      return inTransaction(db, options.tx, async (tx) => {
        const { row } = await lockPost(tx, id);
        if (!isReschedulable(row.status)) {
          throw postNotEditable(row.status);
        }
        await tx
          .update(scheduledPosts)
          .set({ status: "cancelled", updatedAt: touchedAt })
          .where(eq(scheduledPosts.id, id));
        await audit(tx, {
          ...auditActor(actor),
          action: "post.cancelled",
          targetType: "scheduled_post",
          targetId: id,
          data: { itemId: row.itemId, previousStatus: row.status },
        });
        await settleScheduled(tx, row.itemId);
        return mapped(tx, id);
      });
    },
  };
}
