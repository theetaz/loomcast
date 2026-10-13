const monthDay = new Intl.DateTimeFormat("en", { month: "short", day: "numeric" });
const monthDayYear = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  year: "numeric",
});

/** A render length as `m:ss`, such as `0:42` or `1:05`. */
export function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** A target date for a dense cell: `Oct 21`, with the year when it is not this year's. */
export function formatTargetDay(iso: string, now: number = Date.now()): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return "";
  const sameYear = new Date(time).getFullYear() === new Date(now).getFullYear();
  return (sameYear ? monthDay : monthDayYear).format(time);
}

/** Whether a target has passed. */
export function isOverdue(iso: string, now: number = Date.now()): boolean {
  return Date.parse(iso) < now;
}
