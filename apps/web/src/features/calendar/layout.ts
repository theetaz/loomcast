import type { CalendarResponse, CalendarSlot, ScheduledPost } from "@loomcast/contracts";
import { isVisiblePost } from "./model";
import type { CalendarView } from "./search";
import { type CellTarget, placeInstant, targetId } from "./time";

// Which posts and open slots each cell of a view shows.

export type CalendarEntry =
  | { kind: "post"; key: string; post: ScheduledPost; at: number; time: string }
  | { kind: "slot"; key: string; slot: CalendarSlot; at: number; time: string };

/** A month day shows this many entries, then "+n more". */
export const MONTH_VISIBLE_ENTRIES = 3;

/** The id of the lane above the week grid for posts before 06:00 on `day`. */
export function earlyLaneId(day: string): string {
  return `early:${day}`;
}

function cellKey(view: CalendarView, day: string, row: number): string {
  if (view === "month") return targetId({ day, row: null });
  return row < 0 ? earlyLaneId(day) : targetId({ day, row });
}

const PLATFORM_ORDER = ["facebook", "instagram", "threads", "x"];

function platformRank(entry: CalendarEntry): number {
  return entry.kind === "post"
    ? PLATFORM_ORDER.indexOf(entry.post.platform)
    : PLATFORM_ORDER.length;
}

function titleOf(entry: CalendarEntry): string {
  return entry.kind === "post" ? entry.post.item.title : "";
}

/** Time order; at the same time posts come first, grouped by item, then by platform. */
function byTime(a: CalendarEntry, b: CalendarEntry): number {
  return (
    a.at - b.at ||
    (a.kind === b.kind ? 0 : a.kind === "post" ? -1 : 1) ||
    titleOf(a).localeCompare(titleOf(b)) ||
    platformRank(a) - platformRank(b) ||
    (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
  );
}

/**
 * Posts (but cancelled ones) and open slots by cell id, each cell in time order. Entries outside
 * the period's days are left out.
 */
export function layoutEntries(
  view: CalendarView,
  days: readonly string[],
  data: CalendarResponse | undefined,
  zone: string,
): Map<string, CalendarEntry[]> {
  const cells = new Map<string, CalendarEntry[]>();
  if (!data) return cells;
  const shown = new Set(days);
  const add = (entry: CalendarEntry, day: string, row: number) => {
    if (!shown.has(day)) return;
    const key = cellKey(view, day, row);
    const list = cells.get(key);
    if (list) list.push(entry);
    else cells.set(key, [entry]);
  };
  for (const post of data.posts) {
    if (!isVisiblePost(post)) continue;
    const place = placeInstant(post.scheduledAt, zone);
    add(
      { kind: "post", key: post.id, post, at: Date.parse(post.scheduledAt), time: place.time },
      place.day,
      place.row,
    );
  }
  for (const slot of data.slots) {
    if (slot.postId) continue;
    const place = placeInstant(slot.at, zone);
    add(
      {
        kind: "slot",
        key: `${slot.seriesId}:${slot.channelId}:${slot.at}`,
        slot,
        at: Date.parse(slot.at),
        time: place.time,
      },
      place.day,
      place.row,
    );
  }
  for (const list of cells.values()) list.sort(byTime);
  return cells;
}

/** What a month day draws: the first entries, and how many more there are. */
export function monthOverflow(
  entries: readonly CalendarEntry[],
  visible = MONTH_VISIBLE_ENTRIES,
): { shown: CalendarEntry[]; hidden: number } {
  if (entries.length <= visible) return { shown: [...entries], hidden: 0 };
  return { shown: entries.slice(0, visible), hidden: entries.length - visible };
}

/** Whether a period has posts before 06:00, which get a lane above the week grid. */
export function hasEarlyEntries(cells: Map<string, CalendarEntry[]>): boolean {
  for (const key of cells.keys()) if (key.startsWith("early:")) return true;
  return false;
}

/** Where a post starts a keyboard move: its own cell, or the first row when it sits before 06:00. */
export function startTarget(
  view: CalendarView,
  post: ScheduledPost,
  days: readonly string[],
  zone: string,
): CellTarget | null {
  const place = placeInstant(post.scheduledAt, zone);
  if (!days.includes(place.day)) return null;
  return view === "month"
    ? { day: place.day, row: null }
    : { day: place.day, row: Math.max(0, place.row) };
}
