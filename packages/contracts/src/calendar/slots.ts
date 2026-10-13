import { MAX_CALENDAR_RANGE_MS } from "../api/calendar";
import { type Cadence, TIME_OF_DAY_RE, WEEKDAYS, type Weekday } from "../pipeline/format-rules";

// Cadence slots in real time zones, with nothing but `Intl`. A cadence names local times (`09:00`
// on Mondays in `America/New_York`); these helpers turn them into instants and back, so the API,
// the scheduler and the web app agree on every slot, including across daylight saving changes.

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const LOCAL_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let format = formatters.get(timeZone);
  if (format === undefined) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, format);
  }
  return format;
}

/** The wall-clock time at `instantMs` in `timeZone`, written as if it were a UTC timestamp. */
function wallClockMs(instantMs: number, timeZone: string): number {
  const fields: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(new Date(instantMs))) {
    if (part.type !== "literal") fields[part.type] = Number(part.value);
  }
  const hour = fields.hour === 24 ? 0 : (fields.hour ?? 0);
  return Date.UTC(
    fields.year ?? 1970,
    (fields.month ?? 1) - 1,
    fields.day ?? 1,
    hour,
    fields.minute ?? 0,
    fields.second ?? 0,
  );
}

/** How far `timeZone` is ahead of UTC at `instantMs`. */
function offsetMs(instantMs: number, timeZone: string): number {
  return wallClockMs(instantMs, timeZone) - Math.floor(instantMs / 1_000) * 1_000;
}

/**
 * The instant at which `timeZone` shows the wall-clock time `wallMs` (a local time written as a UTC
 * timestamp). Resolved in two passes: the first takes the zone's offsets a day before and a day
 * after as candidates; the second keeps the candidates that really show `wallMs`.
 *
 * - Two candidates: the time repeats (the clocks went back). The earlier instant wins.
 * - No candidate: the time does not exist (the clocks went forward). It moves forward to the first
 *   valid minute, the moment the clocks changed.
 */
function resolveWallClock(wallMs: number, timeZone: string): number {
  const before = offsetMs(wallMs - DAY_MS, timeZone);
  const after = offsetMs(wallMs + DAY_MS, timeZone);
  const valid = [...new Set([before, after])]
    .map((offset) => wallMs - offset)
    .filter((instant) => wallClockMs(instant, timeZone) === wallMs)
    .sort((a, b) => a - b);
  const earliest = valid[0];
  if (earliest !== undefined) return earliest;

  // In the gap: `wallMs - after` still reads the old offset and `wallMs - before` already the new
  // one. Find the first whole minute on the new offset.
  let low = Math.min(wallMs - after, wallMs - before);
  let high = Math.max(wallMs - after, wallMs - before);
  while (high - low > MINUTE_MS) {
    const middle = low + Math.floor((high - low) / 2 / MINUTE_MS) * MINUTE_MS;
    if (offsetMs(middle, timeZone) === after) high = middle;
    else low = middle;
  }
  return high;
}

function epochDayOf(wallMs: number): number {
  return Math.floor(wallMs / DAY_MS);
}

/** `WEEKDAYS` index of a day counted from 1970-01-01, a Thursday. */
function weekdayOf(epochDay: number): Weekday {
  const sundayFirst = new Date(epochDay * DAY_MS).getUTCDay();
  return WEEKDAYS[(sundayFirst + 6) % 7] as Weekday;
}

function minutesOfDay(time: string): number {
  return Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
}

function toMs(value: Date | string, name: string): number {
  const ms = typeof value === "string" ? Date.parse(value) : value.getTime();
  if (!Number.isFinite(ms)) throw new RangeError(`Invalid ${name} time`);
  return ms;
}

/**
 * Every cadence slot in `[from, to)`, in time order and without repeats. Each local `slots` time on
 * each of the `days` in `tz` becomes one instant; a time the clocks skip moves to the first valid
 * minute after the change, and a time that happens twice takes the earlier instant.
 *
 * Returns nothing when `to` is not after `from`. Throws a `RangeError` for invalid times or a
 * range longer than `MAX_CALENDAR_RANGE_DAYS`.
 */
export function generateSlots(
  cadence: Pick<Cadence, "days" | "slots" | "tz">,
  from: Date | string,
  to: Date | string,
): Date[] {
  const fromMs = toMs(from, "start");
  const toMsValue = toMs(to, "end");
  if (toMsValue - fromMs > MAX_CALENDAR_RANGE_MS) {
    throw new RangeError("A slot range must not exceed 62 days");
  }
  if (toMsValue <= fromMs || cadence.days.length === 0 || cadence.slots.length === 0) return [];

  const days = new Set<Weekday>(cadence.days);
  const times = cadence.slots.map(minutesOfDay);
  // A day either side covers slots whose local date differs from their UTC date.
  const firstDay = epochDayOf(wallClockMs(fromMs, cadence.tz)) - 1;
  const lastDay = epochDayOf(wallClockMs(toMsValue, cadence.tz)) + 1;

  const found = new Set<number>();
  for (let day = firstDay; day <= lastDay; day += 1) {
    if (!days.has(weekdayOf(day))) continue;
    for (const minutes of times) {
      const instant = resolveWallClock(day * DAY_MS + minutes * MINUTE_MS, cadence.tz);
      if (instant >= fromMs && instant < toMsValue) found.add(instant);
    }
  }
  return [...found].sort((a, b) => a - b).map((instant) => new Date(instant));
}

/** A local date and time in some time zone. */
export interface LocalDateTime {
  /** `YYYY-MM-DD`. */
  readonly date: string;
  /** `HH:mm`, 24-hour. */
  readonly time: string;
  readonly weekday: Weekday;
}

/** The local date, time and weekday of an instant in `timeZone`, such as for an item's title. */
export function toLocalDateTime(instant: Date | string, timeZone: string): LocalDateTime {
  const wall = new Date(wallClockMs(toMs(instant, "instant"), timeZone));
  const iso = wall.toISOString();
  return {
    date: iso.slice(0, 10),
    time: iso.slice(11, 16),
    weekday: weekdayOf(epochDayOf(wall.getTime())),
  };
}

/**
 * The instant of a local `date` (`YYYY-MM-DD`) and `time` (`HH:mm`) in `timeZone`, resolved like a
 * cadence slot: a skipped time moves forward to the first valid minute, a repeated time takes the
 * earlier instant.
 */
export function fromLocalDateTime(date: string, time: string, timeZone: string): Date {
  const match = LOCAL_DATE_RE.exec(date);
  if (match === null || !TIME_OF_DAY_RE.test(time)) {
    throw new RangeError("Use a YYYY-MM-DD date and an HH:mm time");
  }
  const wallMs = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (new Date(wallMs).toISOString().slice(0, 10) !== date) {
    throw new RangeError(`${date} is not a calendar date`);
  }
  return new Date(resolveWallClock(wallMs + minutesOfDay(time) * MINUTE_MS, timeZone));
}
