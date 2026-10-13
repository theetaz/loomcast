import {
  type Cadence,
  generateSlots,
  isTimeZone,
  MAX_CALENDAR_RANGE_DAYS,
  WEEKDAYS,
  type Weekday,
} from "@loomcast/contracts";

export const WEEKDAY_LABELS: Record<Weekday, { short: string; long: string }> = {
  mon: { short: "Mon", long: "Monday" },
  tue: { short: "Tue", long: "Tuesday" },
  wed: { short: "Wed", long: "Wednesday" },
  thu: { short: "Thu", long: "Thursday" },
  fri: { short: "Fri", long: "Friday" },
  sat: { short: "Sat", long: "Saturday" },
  sun: { short: "Sun", long: "Sunday" },
};

/** Days in week order, without repeats or unknown values. */
export function sortDays(days: readonly string[]): Weekday[] {
  const wanted = new Set(days);
  return WEEKDAYS.filter((day) => wanted.has(day));
}

/** Adds or removes `day`, keeping week order. */
export function toggleDay(days: readonly string[], day: Weekday): Weekday[] {
  return days.includes(day)
    ? sortDays(days.filter((entry) => entry !== day))
    : sortDays([...days, day]);
}

/** Times as `HH:mm` in clock order. Invalid times keep their place at the end. */
export function sortSlots(slots: readonly string[]): string[] {
  return [...slots].sort((a, b) => a.localeCompare(b));
}

function dayRuns(days: readonly Weekday[]): string {
  if (days.length === 7) return "Every day";
  const weekdays = WEEKDAYS.slice(0, 5);
  if (days.length === 5 && weekdays.every((day) => days.includes(day))) return "Weekdays";
  if (days.length === 2 && days.includes("sat") && days.includes("sun")) return "Weekends";
  return days.map((day) => WEEKDAY_LABELS[day].short).join(", ");
}

/**
 * One line for a cadence: `Mon, Wed, Fri at 09:00 · Europe/London`. A cadence without days or
 * times publishes nothing, which is said plainly.
 */
export function cadenceSummary(cadence: Pick<Cadence, "days" | "slots" | "tz">): string {
  const days = sortDays(cadence.days);
  if (days.length === 0 || cadence.slots.length === 0) return "No publishing slots";
  const times = sortSlots(cadence.slots);
  const at = times.length > 3 ? `${times.length} times a day` : `at ${times.join(", ")}`;
  return `${dayRuns(days)} ${at} · ${cadence.tz}`;
}

/** Slots a week, for short summaries. */
export function slotsPerWeek(cadence: Pick<Cadence, "days" | "slots">): number {
  return new Set(cadence.days).size * new Set(cadence.slots).size;
}

const DAY_MS = 24 * 60 * 60_000;

/**
 * The next `count` cadence slots from `now`, looking ahead at most 8 weeks. An invalid cadence
 * (a time zone this browser doesn't know, a malformed time) has none.
 */
export function upcomingSlots(
  cadence: Pick<Cadence, "days" | "slots" | "tz">,
  count: number,
  now: number = Date.now(),
): Date[] {
  if (!isTimeZone(cadence.tz)) return [];
  const found: Date[] = [];
  const windowDays = Math.min(28, MAX_CALENDAR_RANGE_DAYS);
  try {
    for (let start = now; found.length < count && start < now + 56 * DAY_MS; ) {
      const end = start + windowDays * DAY_MS;
      found.push(...generateSlots(cadence, new Date(start), new Date(end)));
      start = end;
      if (cadence.days.length === 0 || cadence.slots.length === 0) break;
    }
  } catch {
    return [];
  }
  return found.slice(0, count);
}

const slotFormats = new Map<string, Intl.DateTimeFormat>();

/** A slot as `Tue, Oct 14, 09:00` in `timeZone` (the browser's when left out). */
export function formatSlot(slot: Date, timeZone?: string): string {
  const key = timeZone ?? "";
  let format = slotFormats.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat("en", {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      ...(timeZone ? { timeZone } : {}),
    });
    slotFormats.set(key, format);
  }
  return format.format(slot);
}

/**
 * The same slot on the viewer's clock, as briefly as possible: `10:00`, or `Thu 01:00` when it
 * falls on another day there.
 */
export function formatLocalSlot(slot: Date, slotZone: string, localZone: string): string {
  const day = (zone: string) =>
    new Intl.DateTimeFormat("en", { weekday: "short", timeZone: zone }).format(slot);
  const time = new Intl.DateTimeFormat("en", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: localZone,
  }).format(slot);
  return day(slotZone) === day(localZone) ? time : `${day(localZone)} ${time}`;
}

/** The browser's own time zone. */
export function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

let zones: string[] | null = null;

/**
 * Every IANA time zone this browser knows, with `UTC` first. Offsets such as `+05:30` are never
 * offered: the contracts refuse them, since they ignore daylight saving time.
 */
export function timeZones(): string[] {
  if (zones) return zones;
  let list: string[] = [];
  try {
    list = Intl.supportedValuesOf("timeZone");
  } catch {
    list = [];
  }
  zones = ["UTC", ...list.filter((zone) => zone !== "UTC" && isTimeZone(zone))];
  return zones;
}

/**
 * Time zones matching `query`, ignoring case, spaces and underscores (`new york` finds
 * `America/New_York`). Names that start with the query come first.
 */
export function searchTimeZones(query: string, list: readonly string[] = timeZones()): string[] {
  const needle = query
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, " ");
  if (!needle) return [...list];
  const normalise = (zone: string) => zone.toLowerCase().replace(/_/g, " ");
  const starts: string[] = [];
  const contains: string[] = [];
  for (const zone of list) {
    const name = normalise(zone);
    const city = name.slice(name.lastIndexOf("/") + 1);
    if (name.startsWith(needle) || city.startsWith(needle)) starts.push(zone);
    else if (name.includes(needle)) contains.push(zone);
  }
  return [...starts, ...contains];
}
