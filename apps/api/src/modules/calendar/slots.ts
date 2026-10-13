import {
  type Cadence,
  CadenceSchema,
  type CalendarSlot,
  type ChannelStatus,
  generateSlots,
  MAX_CALENDAR_RANGE_MS,
  type Platform,
  type PublishMode,
  PublishModeSchema,
  type SeriesStatus,
} from "@loomcast/contracts";
import {
  channels,
  formats,
  formatVersions,
  projects,
  scheduledPosts,
  series,
  seriesChannels,
} from "@loomcast/db";
import { and, asc, eq, gte, inArray, lt, ne, type SQL } from "drizzle-orm";
import type { Executor } from "../../lib/db";

// Cadence slots: every local time of a series' cadence, on each channel the series publishes to.
// The calendar shows the open ones, the cadence planner fills them, and `calendar.get_slots` lists
// them for producer sessions.

/** A channel a series publishes to: its link is enabled and the channel is not disabled. */
export interface PlanChannel {
  id: string;
  platform: Platform;
  status: ChannelStatus;
  dryRun: boolean;
  requiresApproval: boolean;
}

/** A series with what planning needs: its cadence and publish mode, and its channels. */
export interface SeriesPlan {
  id: string;
  projectId: string;
  name: string;
  status: SeriesStatus;
  /** False when the series or its project is not active: it gets no slots. */
  active: boolean;
  /** Null when the format's rules carry no usable cadence. */
  cadence: Cadence | null;
  publishMode: PublishMode;
  rules: unknown;
  channels: PlanChannel[];
}

export interface SeriesFilter {
  projectId?: string;
  seriesIds?: readonly string[];
  /** Only these channels are listed in each plan. */
  channelIds?: readonly string[];
  /** Leave out series that are not active (and series of archived projects). */
  activeOnly?: boolean;
}

function cadenceOf(rules: unknown): Cadence | null {
  if (rules === null || typeof rules !== "object") {
    return null;
  }
  const parsed = CadenceSchema.safeParse((rules as { cadence?: unknown }).cadence);
  return parsed.success ? parsed.data : null;
}

function publishModeOf(rules: unknown): PublishMode {
  if (rules === null || typeof rules !== "object") {
    return "approval";
  }
  const parsed = PublishModeSchema.safeParse((rules as { publishMode?: unknown }).publishMode);
  return parsed.success ? parsed.data : "approval";
}

/** Series with their current format rules and enabled channels, by name then id. */
export async function loadSeriesPlans(
  executor: Executor,
  filter: SeriesFilter = {},
): Promise<SeriesPlan[]> {
  const conditions: (SQL | undefined)[] = [
    filter.projectId === undefined ? undefined : eq(series.projectId, filter.projectId),
    filter.seriesIds === undefined ? undefined : inArray(series.id, [...filter.seriesIds]),
  ];
  if (filter.activeOnly === true) {
    conditions.push(eq(series.status, "active"), eq(projects.status, "active"));
  }
  if (filter.seriesIds !== undefined && filter.seriesIds.length === 0) {
    return [];
  }
  const rows = await executor
    .select({
      id: series.id,
      projectId: series.projectId,
      name: series.name,
      status: series.status,
      projectStatus: projects.status,
      rules: formatVersions.rules,
    })
    .from(series)
    .innerJoin(projects, eq(projects.id, series.projectId))
    .innerJoin(formats, eq(formats.id, series.formatId))
    .innerJoin(formatVersions, eq(formatVersions.id, formats.currentVersionId))
    .where(and(...conditions))
    .orderBy(asc(series.name), asc(series.id));
  if (rows.length === 0) {
    return [];
  }
  const links = await executor
    .select({
      seriesId: seriesChannels.seriesId,
      id: channels.id,
      platform: channels.platform,
      status: channels.status,
      dryRun: channels.dryRun,
      requiresApproval: channels.requiresApproval,
    })
    .from(seriesChannels)
    .innerJoin(channels, eq(channels.id, seriesChannels.channelId))
    .where(
      and(
        inArray(
          seriesChannels.seriesId,
          rows.map((row) => row.id),
        ),
        eq(seriesChannels.enabled, true),
        ne(channels.status, "disabled"),
        filter.channelIds === undefined ? undefined : inArray(channels.id, [...filter.channelIds]),
      ),
    )
    .orderBy(asc(channels.platform), asc(channels.id));
  const bySeries = new Map<string, PlanChannel[]>();
  for (const { seriesId, ...channel } of links) {
    const list = bySeries.get(seriesId) ?? [];
    list.push(channel);
    bySeries.set(seriesId, list);
  }
  return rows.map((row) => ({
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    status: row.status,
    active: row.status === "active" && row.projectStatus === "active",
    cadence: cadenceOf(row.rules),
    publishMode: publishModeOf(row.rules),
    rules: row.rules,
    channels: bySeries.get(row.id) ?? [],
  }));
}

/**
 * The cadence instants of a plan in `[from, to)`, for any range length (the contracts' generator
 * takes at most 62 days at a time). Empty for a series that is not active or has no cadence.
 */
export function cadenceSlots(plan: SeriesPlan, from: Date, to: Date): Date[] {
  if (!plan.active || plan.cadence === null) {
    return [];
  }
  const slots: Date[] = [];
  for (let start = from.getTime(); start < to.getTime(); start += MAX_CALENDAR_RANGE_MS) {
    const end = Math.min(start + MAX_CALENDAR_RANGE_MS, to.getTime());
    slots.push(...generateSlots(plan.cadence, new Date(start), new Date(end)));
  }
  return slots;
}

/** Key of a slot on one channel. */
function slotKey(seriesId: string, channelId: string, at: number): string {
  return `${seriesId}|${channelId}|${at}`;
}

export interface SlotQuery extends SeriesFilter {
  from: Date;
  to: Date;
}

/**
 * The slots of active series in `[from, to)` on each of their channels, in time order (then by
 * series and channel). A slot is held (`postId`) when a post that is not cancelled has the same
 * series, channel and time; a post moved elsewhere leaves its slot open.
 */
export async function listSlots(executor: Executor, query: SlotQuery): Promise<CalendarSlot[]> {
  if (query.to.getTime() <= query.from.getTime()) {
    return [];
  }
  const plans = await loadSeriesPlans(executor, { ...query, activeOnly: true });
  const withChannels = plans.filter((plan) => plan.channels.length > 0 && plan.cadence !== null);
  if (withChannels.length === 0) {
    return [];
  }
  const held = await executor
    .select({
      id: scheduledPosts.id,
      seriesId: scheduledPosts.seriesId,
      channelId: scheduledPosts.channelId,
      scheduledAt: scheduledPosts.scheduledAt,
    })
    .from(scheduledPosts)
    .where(
      and(
        inArray(
          scheduledPosts.seriesId,
          withChannels.map((plan) => plan.id),
        ),
        ne(scheduledPosts.status, "cancelled"),
        gte(scheduledPosts.scheduledAt, query.from),
        lt(scheduledPosts.scheduledAt, query.to),
      ),
    )
    .orderBy(asc(scheduledPosts.createdAt), asc(scheduledPosts.id));
  const holders = new Map<string, string>();
  for (const post of held) {
    if (post.seriesId === null) continue;
    const key = slotKey(post.seriesId, post.channelId, post.scheduledAt.getTime());
    if (!holders.has(key)) holders.set(key, post.id);
  }

  const slots: CalendarSlot[] = [];
  for (const plan of withChannels) {
    for (const at of cadenceSlots(plan, query.from, query.to)) {
      for (const channel of plan.channels) {
        const postId = holders.get(slotKey(plan.id, channel.id, at.getTime()));
        slots.push({
          at: at.toISOString(),
          seriesId: plan.id,
          channelId: channel.id,
          ...(postId === undefined ? {} : { postId }),
        });
      }
    }
  }
  return slots.sort(
    (a, b) =>
      a.at.localeCompare(b.at) ||
      a.seriesId.localeCompare(b.seriesId) ||
      a.channelId.localeCompare(b.channelId),
  );
}
