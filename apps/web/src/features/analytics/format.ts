import type { PostMetrics } from "@loomcast/contracts";

// Number and date formats for the analytics screens. Dates are UTC days, because the API groups
// posts by UTC publish day.

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const whole = new Intl.NumberFormat("en", { maximumFractionDigits: 0 });
const percent = new Intl.NumberFormat("en", {
  style: "percent",
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});
const seconds = new Intl.NumberFormat("en", { maximumFractionDigits: 1, minimumFractionDigits: 1 });

/** Shown for a figure that has no value: not reported, or nothing to compute it from. */
export const NO_VALUE = "—";

/** A count for tiles, labels and axes: `842`, then `12.9K`, `4.2M`. */
export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return NO_VALUE;
  return Math.abs(value) < 1_000 ? whole.format(value) : compact.format(value);
}

/** A count in full, for tables and tooltips: `12,904`. */
export function formatFullCount(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return NO_VALUE;
  return whole.format(value);
}

/** A share as a percentage with one decimal: `0.0482` is `4.8%`. */
export function formatRate(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return NO_VALUE;
  return percent.format(value);
}

/** Watch time: `12.4 s` below a minute, `1:05 min` from one. */
export function formatWatch(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return NO_VALUE;
  if (ms < 60_000) return `${seconds.format(ms / 1000)} s`;
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")} min`;
}

/** `(likes + comments + shares + saves) / views` of one capture; null without views. */
export function engagementRate(
  metrics: Pick<PostMetrics, "views" | "likes" | "comments" | "shares" | "saves"> | null,
): number | null {
  if (!metrics?.views) return null;
  const engagements =
    (metrics.likes ?? 0) + (metrics.comments ?? 0) + (metrics.shares ?? 0) + (metrics.saves ?? 0);
  return engagements / metrics.views;
}

/** The metrics of one capture, in the order the item card lists them. */
export const METRICS = [
  { key: "views", label: "Views" },
  { key: "likes", label: "Likes" },
  { key: "comments", label: "Comments" },
  { key: "shares", label: "Shares" },
  { key: "saves", label: "Saves" },
  { key: "reach", label: "Reach" },
  { key: "avgWatchMs", label: "Avg. watch time" },
] as const satisfies readonly { key: keyof PostMetrics; label: string }[];

export type MetricKey = (typeof METRICS)[number]["key"];

/** One metric's value for a tile, a table cell or a tooltip. */
export function formatMetric(key: MetricKey, value: number | null, full = false): string {
  if (key === "avgWatchMs") return formatWatch(value);
  return full ? formatFullCount(value) : formatCount(value);
}

const day = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", timeZone: "UTC" });
const dayYear = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});
const month = new Intl.DateTimeFormat("en", { month: "short", year: "numeric", timeZone: "UTC" });
const shortMonth = new Intl.DateTimeFormat("en", { month: "short", timeZone: "UTC" });
const local = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

/** A UTC day: `Oct 3`. */
export function formatDay(time: number, withYear = false): string {
  return (withYear ? dayYear : day).format(time);
}

/** A UTC month: `Oct 2026`, or `Oct` for axis ticks. */
export function formatMonth(time: number, short = false): string {
  return (short ? shortMonth : month).format(time);
}

/** A capture or publish time in the viewer's zone: `Oct 3, 4:05 PM`. */
export function formatMoment(iso: string): string {
  const time = Date.parse(iso);
  return Number.isNaN(time) ? "" : local.format(time);
}

/** `1 post`, `3 posts`. */
export function plural(count: number, one: string, many = `${one}s`): string {
  return `${formatFullCount(count)} ${count === 1 ? one : many}`;
}
