const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export type CountdownTone = "red" | "amber" | "blue" | "gray";

export interface Countdown {
  /** Short, for the pill: `45m`, `3h 12m`, `2d 4h`. */
  label: string;
  tone: CountdownTone;
  /** A sentence for screen readers and tooltips. */
  description: string;
}

/** `45m`, `3h 12m`, `2d 4h`: two units at most, never rounded up past the slot. */
export function formatSpan(ms: number): string {
  const minutes = Math.max(1, Math.floor(ms / MINUTE));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest ? `${hours}h ${rest}m` : `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  return rest ? `${days}d ${rest}h` : `${days}d`;
}

/**
 * Time left before an item's first slot: red under two hours (and once the slot passed), amber
 * within a day, blue within three days, gray after that or without a slot.
 */
export function slotCountdown(deadlineAt: string | null, now: number = Date.now()): Countdown {
  if (deadlineAt === null) {
    return {
      label: "No slot",
      tone: "gray",
      description: "No post is planned for it yet",
    };
  }
  const left = Date.parse(deadlineAt) - now;
  if (left <= 0) {
    const late = formatSpan(-left);
    return {
      label: `${late} late`,
      tone: "red",
      description: `Its slot passed ${late} ago`,
    };
  }
  const span = formatSpan(left);
  const tone: CountdownTone =
    left < 2 * HOUR ? "red" : left < DAY ? "amber" : left < 3 * DAY ? "blue" : "gray";
  return { label: span, tone, description: `${span} until its slot` };
}
