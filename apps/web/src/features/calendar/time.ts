import { TZDate } from "@date-fns/tz";
import { fromLocalDateTime, toLocalDateTime } from "@loomcast/contracts";
import { addDays, addMonths, format, startOfMonth, startOfWeek } from "date-fns";
import type { CalendarView } from "./search";

// Calendar time in one display zone. Days are `YYYY-MM-DD` keys, which mean the same date in every
// zone; instants are ISO timestamps. Periods are computed with date-fns on `TZDate`, so a week that
// crosses a daylight saving change is 167 or 169 hours long, and cells map to instants with the
// contracts' `fromLocalDateTime`, the same rule the API and the scheduler use.

/** The week grid starts at 06:00 and ends at midnight, in half-hour rows. */
export const DAY_START_MINUTES = 6 * 60;
export const SLOT_MINUTES = 30;
export const WEEK_ROWS = (24 * 60 - DAY_START_MINUTES) / SLOT_MINUTES;
/** Six weeks, so any month fits with the weeks around it. */
export const MONTH_GRID_DAYS = 42;
/** Weeks start on Monday, like cadence days. */
const WEEK_OPTIONS = { weekStartsOn: 1 } as const;

/** The browser's IANA time zone; UTC when the browser does not say. */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function parts(day: string): [number, number, number] {
  const [year, month, date] = day.split("-").map(Number);
  return [year ?? 1970, (month ?? 1) - 1, date ?? 1];
}

/** Local midnight of `day` in `zone`. */
function startOfDayIn(day: string, zone: string): TZDate {
  const [year, month, date] = parts(day);
  return new TZDate(year, month, date, zone);
}

function keyOf(date: Date): string {
  return format(date, "yyyy-MM-dd");
}

function iso(date: Date): string {
  return new Date(date.getTime()).toISOString();
}

/** Today's date in `zone`. */
export function todayIn(zone: string, now = Date.now()): string {
  return toLocalDateTime(new Date(now), zone).date;
}

/** The days a view shows and the instants it covers, `[from, to)`. */
export interface CalendarPeriod {
  view: CalendarView;
  /** The day the period was opened on. */
  anchor: string;
  /** Seven days for a week; 42 for a month grid. */
  days: string[];
  /** The month a month grid is about, `YYYY-MM`. */
  month: string;
  from: string;
  to: string;
}

export function calendarPeriod(view: CalendarView, anchor: string, zone: string): CalendarPeriod {
  const date = startOfDayIn(anchor, zone);
  const start = startOfWeek(view === "week" ? date : startOfMonth(date), WEEK_OPTIONS);
  const length = view === "week" ? 7 : MONTH_GRID_DAYS;
  return {
    view,
    anchor,
    days: Array.from({ length }, (_, index) => keyOf(addDays(start, index))),
    month: anchor.slice(0, 7),
    from: iso(start),
    to: iso(addDays(start, length)),
  };
}

/** The anchor `delta` weeks or months away. A month moves to its first day. */
export function shiftAnchor(view: CalendarView, anchor: string, delta: number): string {
  const date = startOfDayIn(anchor, "UTC");
  return keyOf(view === "week" ? addDays(date, 7 * delta) : addMonths(startOfMonth(date), delta));
}

function dayDate(day: string): TZDate {
  return startOfDayIn(day, "UTC");
}

/** `12 – 18 Oct 2026`, `28 Sep – 4 Oct 2026` or `October 2026`. */
export function periodLabel(period: CalendarPeriod): string {
  if (period.view === "month") return format(dayDate(`${period.month}-01`), "MMMM yyyy");
  const first = dayDate(period.days[0] ?? period.anchor);
  const last = dayDate(period.days.at(-1) ?? period.anchor);
  if (first.getFullYear() !== last.getFullYear()) {
    return `${format(first, "d MMM yyyy")} – ${format(last, "d MMM yyyy")}`;
  }
  if (first.getMonth() !== last.getMonth()) {
    return `${format(first, "d MMM")} – ${format(last, "d MMM yyyy")}`;
  }
  return `${format(first, "d")} – ${format(last, "d MMM yyyy")}`;
}

/** `Tue 14` for column headers. */
export function shortDayLabel(day: string): { weekday: string; date: string } {
  const date = dayDate(day);
  return { weekday: format(date, "EEE"), date: format(date, "d") };
}

/** `Tuesday 14 October`, for screen readers and dialogs. */
export function longDayLabel(day: string): string {
  return format(dayDate(day), "EEEE d MMMM");
}

/** Weekday names, Monday first. */
export const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

/** `HH:mm` of a week row. */
export function rowTime(row: number): string {
  return clockTime(DAY_START_MINUTES + row * SLOT_MINUTES);
}

/** Where an instant sits in `zone`: its day, time and week row (`-1` before 06:00). */
export interface Placement {
  day: string;
  time: string;
  row: number;
}

export function placeInstant(instant: string | Date, zone: string): Placement {
  const local = toLocalDateTime(instant, zone);
  const minutes = Number(local.time.slice(0, 2)) * 60 + Number(local.time.slice(3, 5));
  const row =
    minutes < DAY_START_MINUTES ? -1 : Math.floor((minutes - DAY_START_MINUTES) / SLOT_MINUTES);
  return { day: local.date, time: local.time, row };
}

/** The instant a week cell starts at in `zone`. */
export function cellInstant(day: string, row: number, zone: string): Date {
  return fromLocalDateTime(day, rowTime(row), zone);
}

/** The instant of `time` on `day` in `zone`, for moves in the month view. */
export function dayTimeInstant(day: string, time: string, zone: string): Date {
  return fromLocalDateTime(day, time, zone);
}

/** `HH:mm` of an instant in `zone`. */
export function timeIn(instant: string | Date, zone: string): string {
  return toLocalDateTime(instant, zone).time;
}

// Drop targets ----------------------------------------------------------------------

/** A week cell (`row` ≥ 0) or a month day (`row` null). */
export interface CellTarget {
  day: string;
  row: number | null;
}

export function targetId(target: CellTarget): string {
  return target.row === null ? `day:${target.day}` : `cell:${target.day}:${target.row}`;
}

export const ARROW_KEYS = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"] as const;
export type ArrowKey = (typeof ARROW_KEYS)[number];

export function isArrowKey(code: string): code is ArrowKey {
  return (ARROW_KEYS as readonly string[]).includes(code);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * The target one key press away. In the week view up and down move by half an hour and left and
 * right by a day; in the month view left and right move by a day and up and down by a week. Moves
 * stop at the edges of the period.
 */
export function stepTarget(
  view: CalendarView,
  target: CellTarget,
  key: ArrowKey,
  days: readonly string[],
): CellTarget {
  const index = days.indexOf(target.day);
  if (index === -1) return target;
  const dayAt = (next: number) => days[clamp(next, 0, days.length - 1)] ?? target.day;
  if (view === "week") {
    const row = target.row ?? 0;
    switch (key) {
      case "ArrowUp":
        return { day: target.day, row: clamp(row - 1, 0, WEEK_ROWS - 1) };
      case "ArrowDown":
        return { day: target.day, row: clamp(row + 1, 0, WEEK_ROWS - 1) };
      case "ArrowLeft":
        return { day: dayAt(index - 1), row };
      case "ArrowRight":
        return { day: dayAt(index + 1), row };
    }
  }
  const delta = { ArrowUp: -7, ArrowDown: 7, ArrowLeft: -1, ArrowRight: 1 }[key];
  return { day: dayAt(index + delta), row: null };
}

function minutesOf(time: string): number {
  return Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
}

function clockTime(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/**
 * The local time a post lands on at `target`. A week cell keeps the post's minutes within its half
 * hour (09:15 dropped on the 11:00 row lands at 11:15); a month day keeps its time of day.
 */
export function targetTime(target: CellTarget, scheduledAt: string, zone: string): string {
  const place = placeInstant(scheduledAt, zone);
  if (target.row === null) return place.time;
  const offset = place.row < 0 ? 0 : (minutesOf(place.time) - DAY_START_MINUTES) % SLOT_MINUTES;
  return clockTime(DAY_START_MINUTES + target.row * SLOT_MINUTES + offset);
}

/** The instant a post moves to when dropped on `target`. */
export function targetInstant(target: CellTarget, scheduledAt: string, zone: string): Date {
  return fromLocalDateTime(target.day, targetTime(target, scheduledAt, zone), zone);
}
