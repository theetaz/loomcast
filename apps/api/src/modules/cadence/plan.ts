import {
  canTransition,
  MIN_SCHEDULE_LEAD_MS,
  OPEN_POST_STATUSES,
  type PipelineState,
  type PublishingMode,
  toLocalDateTime,
} from "@loomcast/contracts";
import { contentItems, type Database, scheduledPosts, scheduledTasks, series } from "@loomcast/db";
import {
  and,
  asc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  lt,
  ne,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import type { EventBus } from "../../lib/bus";
import { afterCommit, type Transaction, transaction } from "../../lib/db";
import type { Logger } from "../../lib/logger";
import {
  enqueuePublish,
  loadScheduledPosts,
  newPostDryRun,
  publishPostsUpdated,
  touchedAt,
} from "../calendar/posts";
import { cadenceSlots, loadSeriesPlans, type SeriesPlan } from "../calendar/slots";
import { type ContentService, SYSTEM_ACTOR } from "../content";
import type { Scheduler } from "../scheduler";
import { pickTopic, type TopicUse } from "./topics";

// The cadence planner. For each slot of a series' cadence over the planning horizon it makes sure
// there is an item (an idea with the slot as its target) and a planned post on each channel the
// series publishes to, and queues the item's production ahead of the slot and each post's publish
// task at the slot. Running it again changes nothing. Slots the cadence no longer has (the series
// was paused, its cadence changed or a channel was switched off) give up their untouched ideas.

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

/** Item states in which a newly linked channel still gets a planned post. */
const PLANNABLE_STATES: readonly PipelineState[] = [
  "idea",
  "script",
  "storyboard",
  "voice",
  "render",
  "review",
];

/** Why the planner retires an idea, for the audit log and the state change event. */
export const RETIRE_REASON = "The series no longer has this slot.";

export interface PlannerDeps {
  db: Database;
  bus: EventBus;
  logger: Logger;
  scheduler: Pick<Scheduler, "enqueue">;
  content: Pick<ContentService, "create" | "transition" | "track" | "activeJob">;
  config: { publishing: { mode: PublishingMode }; cadenceHorizonDays: number };
}

export interface PlanResult {
  seriesId: string;
  slots: number;
  createdItems: string[];
  createdPosts: string[];
  /** Ideas that lost their slot: archived, or detached from the calendar. */
  retiredItems: string[];
  cancelledPosts: string[];
  /** Planned posts on channels the series no longer publishes to, removed. */
  removedPosts: string[];
}

/** Dedupe key of an item's `cadence.produce` task. */
export function produceTaskKey(itemId: string): string {
  return `produce:${itemId}`;
}

/** Dedupe key of a series' own `cadence.plan` task (after a change to the series). */
export function planTaskKey(seriesId: string): string {
  return `plan:${seriesId}`;
}

/** The title of a planned item: `<series> · <local date>`, with the time when a day has several. */
export function plannedTitle(plan: Pick<SeriesPlan, "name" | "cadence">, slot: Date): string {
  const tz = plan.cadence?.tz ?? "UTC";
  const local = toLocalDateTime(slot, tz);
  const several = (plan.cadence?.slots.length ?? 0) > 1;
  return several ? `${plan.name} · ${local.date} ${local.time}` : `${plan.name} · ${local.date}`;
}

/** When production of an item for `slot` starts: `leadTimeHours` before it, but not in the past. */
export function produceAt(plan: Pick<SeriesPlan, "cadence">, slot: Date, now: Date): Date {
  const lead = (plan.cadence?.leadTimeHours ?? 0) * HOUR_MS;
  return new Date(Math.max(now.getTime(), slot.getTime() - lead));
}

/** Series the hourly run visits: active ones, and any that still hold future planned posts. */
export async function seriesToPlan(db: Database, now: Date): Promise<string[]> {
  const active = await db
    .select({ id: series.id })
    .from(series)
    .where(eq(series.status, "active"))
    .orderBy(asc(series.id));
  const holding = await db
    .selectDistinct({ id: scheduledPosts.seriesId })
    .from(scheduledPosts)
    .where(
      and(
        isNotNull(scheduledPosts.seriesId),
        eq(scheduledPosts.status, "planned"),
        gt(scheduledPosts.scheduledAt, now),
      ),
    );
  const ids = new Set(active.map((row) => row.id));
  for (const row of holding) {
    if (row.id !== null) ids.add(row.id);
  }
  return [...ids].sort();
}

/**
 * Plans one series in one transaction, holding its row `FOR UPDATE` so two planners never fill
 * the same slots. Null when there is no such series.
 */
export async function planSeries(
  deps: PlannerDeps,
  seriesId: string,
  now: Date,
): Promise<PlanResult | null> {
  return transaction(deps.db, async (tx) => {
    const [locked] = await tx
      .select({ id: series.id })
      .from(series)
      .where(eq(series.id, seriesId))
      .for("update");
    if (locked === undefined) {
      return null;
    }
    const [plan] = await loadSeriesPlans(tx, { seriesIds: [seriesId] });
    if (plan === undefined) {
      return null;
    }
    const from = new Date(now.getTime() + MIN_SCHEDULE_LEAD_MS);
    const to = new Date(now.getTime() + deps.config.cadenceHorizonDays * DAY_MS);
    const slots = plan.channels.length === 0 ? [] : cadenceSlots(plan, from, to);
    const result: PlanResult = {
      seriesId,
      slots: slots.length,
      createdItems: [],
      createdPosts: [],
      retiredItems: [],
      cancelledPosts: [],
      removedPosts: [],
    };
    await retire(deps, tx, plan, slots, from, result);
    await fill(deps, tx, plan, slots, { now, from, to }, result);
    await publishPostsUpdated(tx, deps.bus, [...result.createdPosts, ...result.cancelledPosts]);
    return result;
  });
}

/**
 * Gives up the future ideas of the series whose slot is gone: their open posts are cancelled and
 * the item is archived (or, where the system may not archive, detached from the calendar). Ideas
 * whose slot remains lose only their posts on channels the series no longer publishes to. Only
 * ideas the planner made and no production job is working on are touched.
 */
async function retire(
  deps: PlannerDeps,
  tx: Transaction,
  plan: SeriesPlan,
  slots: readonly Date[],
  from: Date,
  result: PlanResult,
): Promise<void> {
  const slotTimes = new Set(slots.map((slot) => slot.getTime()));
  const channelIds = plan.channels.map((channel) => channel.id);
  const ideas = await tx
    .select({ id: contentItems.id, targetAt: contentItems.targetAt })
    .from(contentItems)
    .where(
      and(
        eq(contentItems.seriesId, plan.id),
        eq(contentItems.state, "idea"),
        eq(contentItems.createdVia, "system"),
        gte(contentItems.targetAt, from),
      ),
    )
    .orderBy(asc(contentItems.targetAt), asc(contentItems.id))
    .for("update");

  for (const idea of ideas) {
    const keepsSlot = idea.targetAt !== null && slotTimes.has(idea.targetAt.getTime());
    if (keepsSlot) {
      // The slot stays: its posts on channels the series stopped publishing to are unplanned.
      // They are removed rather than cancelled, so the channel gets them back if it is switched
      // on again (a cancelled post means a person withdrew it, and is never planned again).
      const unplanned = await tx
        .select({ id: scheduledPosts.id })
        .from(scheduledPosts)
        .where(
          and(
            eq(scheduledPosts.itemId, idea.id),
            eq(scheduledPosts.status, "planned"),
            eq(scheduledPosts.attempts, 0),
            notInArray(scheduledPosts.channelId, channelIds),
          ),
        )
        .for("update");
      if (unplanned.length > 0) {
        const ids = unplanned.map((row) => row.id);
        const removed = await loadScheduledPosts(tx, ids);
        await tx.delete(scheduledPosts).where(inArray(scheduledPosts.id, ids));
        afterCommit(tx, () => {
          for (const post of removed) {
            deps.bus.publish({
              type: "post.updated",
              payload: { post: { ...post, status: "cancelled" } },
            });
          }
        });
        result.removedPosts.push(...ids);
      }
      continue;
    }
    if ((await deps.content.activeJob(idea.id, tx)) !== null) {
      continue;
    }
    const cancelled = await tx
      .update(scheduledPosts)
      .set({ status: "cancelled", updatedAt: touchedAt })
      .where(
        and(
          eq(scheduledPosts.itemId, idea.id),
          inArray(scheduledPosts.status, [...OPEN_POST_STATUSES]),
        ),
      )
      .returning({ id: scheduledPosts.id });
    result.cancelledPosts.push(...cancelled.map((row) => row.id));
    if (canTransition("idea", "archived", "system")) {
      await deps.content.transition(tx, idea.id, "archived", SYSTEM_ACTOR, {
        via: "archive",
        reason: RETIRE_REASON,
      });
    } else {
      await deps.content.track(tx, idea.id, { targetAt: null, autopilotTarget: null });
    }
    result.retiredItems.push(idea.id);
  }
}

interface Window {
  now: Date;
  from: Date;
  to: Date;
}

/** Creates the missing items, posts and tasks of the slots. */
async function fill(
  deps: PlannerDeps,
  tx: Transaction,
  plan: SeriesPlan,
  slots: readonly Date[],
  window: Window,
  result: PlanResult,
): Promise<void> {
  if (slots.length === 0) {
    return;
  }
  const existing = await tx
    .select({
      id: contentItems.id,
      state: contentItems.state,
      targetAt: contentItems.targetAt,
    })
    .from(contentItems)
    .where(
      and(
        eq(contentItems.seriesId, plan.id),
        ne(contentItems.state, "archived"),
        gte(contentItems.targetAt, window.from),
        lt(contentItems.targetAt, window.to),
      ),
    )
    .orderBy(asc(contentItems.createdAt), asc(contentItems.id));
  const bySlot = new Map<number, { id: string; state: PipelineState }>();
  for (const item of existing) {
    if (item.targetAt !== null && !bySlot.has(item.targetAt.getTime())) {
      bySlot.set(item.targetAt.getTime(), { id: item.id, state: item.state });
    }
  }
  const itemIds = [...bySlot.values()].map((item) => item.id);
  const posted = new Set<string>();
  if (itemIds.length > 0) {
    // Any post counts, cancelled ones too: a post a person cancelled is not planned again.
    const rows = await tx
      .select({ itemId: scheduledPosts.itemId, channelId: scheduledPosts.channelId })
      .from(scheduledPosts)
      .where(inArray(scheduledPosts.itemId, itemIds));
    for (const row of rows) posted.add(`${row.itemId}|${row.channelId}`);
  }
  const history = await topicHistory(tx, plan.id);
  const dryRunMode = deps.config.publishing.mode;

  for (const slot of slots) {
    let item = bySlot.get(slot.getTime());
    if (item === undefined) {
      const topic = pickTopic({
        pool: topicPoolOf(plan.rules),
        avoid: avoidListOf(plan.rules),
        history,
      });
      const created = await deps.content.create(
        plan.projectId,
        {
          title: plannedTitle(plan, slot),
          seriesId: plan.id,
          targetAt: slot.toISOString(),
          ...(topic === null ? {} : { topic }),
        },
        SYSTEM_ACTOR,
        { tx, createdVia: "system" },
      );
      item = { id: created.item.id, state: created.item.state };
      if (topic !== null) history.push({ topic, at: slot });
      result.createdItems.push(item.id);
      await deps.scheduler.enqueue(
        tx,
        "cadence.produce",
        { itemId: item.id },
        { runAt: produceAt(plan, slot, window.now), dedupeKey: produceTaskKey(item.id) },
      );
    }
    if (!PLANNABLE_STATES.includes(item.state)) {
      continue;
    }
    for (const channel of plan.channels) {
      if (posted.has(`${item.id}|${channel.id}`)) continue;
      const [post] = await tx
        .insert(scheduledPosts)
        .values({
          itemId: item.id,
          channelId: channel.id,
          seriesId: plan.id,
          scheduledAt: slot,
          status: "planned",
          dryRun: newPostDryRun(channel, dryRunMode),
        })
        .onConflictDoNothing({
          target: [scheduledPosts.itemId, scheduledPosts.channelId],
          where: sql`${scheduledPosts.status} <> 'cancelled'`,
        })
        .returning({ id: scheduledPosts.id, scheduledAt: scheduledPosts.scheduledAt });
      posted.add(`${item.id}|${channel.id}`);
      if (post === undefined) continue;
      result.createdPosts.push(post.id);
      await enqueuePublish(tx, deps.scheduler, post);
    }
  }
  await moveProduceTasks(deps, tx, plan, itemIds, window.now);
}

/**
 * Keeps the pending production tasks of existing ideas in step with the lead time: each starts
 * `leadTimeHours` before the item's earliest open post. Tasks that already ran are left alone.
 */
async function moveProduceTasks(
  deps: PlannerDeps,
  tx: Transaction,
  plan: SeriesPlan,
  itemIds: readonly string[],
  now: Date,
): Promise<void> {
  if (itemIds.length === 0) {
    return;
  }
  const pending = await tx
    .select({ dedupeKey: scheduledTasks.dedupeKey, runAt: scheduledTasks.runAt })
    .from(scheduledTasks)
    .where(
      and(
        eq(scheduledTasks.kind, "cadence.produce"),
        eq(scheduledTasks.status, "pending"),
        inArray(scheduledTasks.dedupeKey, itemIds.map(produceTaskKey)),
      ),
    );
  if (pending.length === 0) {
    return;
  }
  const earliest = await tx
    .select({
      itemId: scheduledPosts.itemId,
      at: sql<Date>`min(${scheduledPosts.scheduledAt})`.mapWith(scheduledPosts.scheduledAt),
    })
    .from(scheduledPosts)
    .where(
      and(
        inArray(scheduledPosts.itemId, [...itemIds]),
        inArray(scheduledPosts.status, [...OPEN_POST_STATUSES]),
      ),
    )
    .groupBy(scheduledPosts.itemId);
  const runAtByKey = new Map(pending.map((task) => [task.dedupeKey, task.runAt.getTime()]));
  for (const { itemId, at } of earliest) {
    const key = produceTaskKey(itemId);
    const current = runAtByKey.get(key);
    if (current === undefined) continue;
    const runAt = produceAt(plan, at, now);
    if (runAt.getTime() === current) continue;
    await deps.scheduler.enqueue(tx, "cadence.produce", { itemId }, { runAt, dedupeKey: key });
  }
}

/** Topics the series' items used: live items, and ideas that still hold a slot. */
async function topicHistory(tx: Transaction, seriesId: string): Promise<TopicUse[]> {
  const rows = await tx
    .select({
      topic: contentItems.topic,
      targetAt: contentItems.targetAt,
      createdAt: contentItems.createdAt,
    })
    .from(contentItems)
    .where(
      and(
        eq(contentItems.seriesId, seriesId),
        isNotNull(contentItems.topic),
        ne(contentItems.state, "archived"),
        or(ne(contentItems.state, "idea"), isNotNull(contentItems.targetAt)),
      ),
    );
  return rows.flatMap((row) =>
    row.topic === null ? [] : [{ topic: row.topic, at: row.targetAt ?? row.createdAt }],
  );
}

function stringList(rules: unknown, key: "topicPool" | "avoid"): string[] {
  if (rules === null || typeof rules !== "object") return [];
  const value = (rules as Record<string, unknown>)[key];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function topicPoolOf(rules: unknown): string[] {
  return stringList(rules, "topicPool");
}

function avoidListOf(rules: unknown): string[] {
  return stringList(rules, "avoid");
}
