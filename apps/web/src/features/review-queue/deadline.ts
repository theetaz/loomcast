const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export type DeadlineTone = "red" | "amber" | "blue" | "gray";

export interface Deadline {
  label: string;
  tone: DeadlineTone;
  /** For screen readers and tooltips. */
  description: string;
}

const dayFormat = new Intl.DateTimeFormat("en", { month: "short", day: "numeric" });

function span(ms: number): string {
  if (ms < HOUR) return `${Math.max(1, Math.round(ms / MINUTE))}m`;
  if (ms < DAY) return `${Math.round(ms / HOUR)}h`;
  return `${Math.round(ms / DAY)}d`;
}

/**
 * How urgent a review is, from the item's target time: red once it has passed, amber inside a
 * day, blue inside three days, gray after that or without a target.
 */
export function deadlineOf(targetAt: string | null, now: number = Date.now()): Deadline {
  if (!targetAt) {
    return { label: "No date", tone: "gray", description: "No publishing date set" };
  }
  const left = Date.parse(targetAt) - now;
  if (left <= 0) {
    return {
      label: `${span(-left)} late`,
      tone: "red",
      description: `The publishing date passed ${span(-left)} ago`,
    };
  }
  if (left < DAY) {
    return {
      label: `Due in ${span(left)}`,
      tone: "amber",
      description: `Publishes in ${span(left)}`,
    };
  }
  if (left < 3 * DAY) {
    return {
      label: `Due in ${span(left)}`,
      tone: "blue",
      description: `Publishes in ${span(left)}`,
    };
  }
  const day = dayFormat.format(Date.parse(targetAt));
  return { label: `Due ${day}`, tone: "gray", description: `Publishes on ${day}` };
}
