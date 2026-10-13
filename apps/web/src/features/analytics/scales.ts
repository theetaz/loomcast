import type { AnalyticsOverview, Platform, PostPerformance } from "@loomcast/contracts";
import { scaleBand, scaleLinear } from "d3-scale";
import { curveMonotoneX, line } from "d3-shape";
import { formatDay, formatMonth } from "./format";
import { orderPlatforms } from "./platforms";

const DAY_MS = 24 * 60 * 60_000;

// Chart geometry, kept apart from the components so the scales can be tested on their own.

/** How the views trend groups publish days: by day up to 45 days, by week up to 200, else month. */
export type Granularity = "day" | "week" | "month";

export function granularityFor(fromMs: number, toMs: number): Granularity {
  const days = (toMs - fromMs) / DAY_MS;
  if (days <= 45) return "day";
  if (days <= 200) return "week";
  return "month";
}

/** The UTC start of the day, week (from Monday) or month holding `time`. */
export function bucketStart(time: number, granularity: Granularity): number {
  const date = new Date(time);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  if (granularity === "month") return Date.UTC(year, month, 1);
  const day = Date.UTC(year, month, date.getUTCDate());
  if (granularity === "day") return day;
  const sinceMonday = (date.getUTCDay() + 6) % 7;
  return day - sinceMonday * DAY_MS;
}

function nextBucket(start: number, granularity: Granularity): number {
  if (granularity === "day") return start + DAY_MS;
  if (granularity === "week") return start + 7 * DAY_MS;
  const date = new Date(start);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
}

export interface Bucket {
  start: number;
  /** For tooltips and table rows: `Oct 3`, `Week of Oct 3`, `Oct 2026`. */
  label: string;
  /** For axis ticks: `Oct 3`, `Oct`. */
  tick: string;
}

export function bucketLabel(start: number, granularity: Granularity): Bucket {
  if (granularity === "month") {
    return { start, label: formatMonth(start), tick: formatMonth(start, true) };
  }
  const day = formatDay(start);
  return { start, label: granularity === "week" ? `Week of ${day}` : day, tick: day };
}

/** Every bucket from the one holding `fromMs` up to `toMs` (exclusive). */
export function bucketsBetween(fromMs: number, toMs: number, granularity: Granularity): Bucket[] {
  const buckets: Bucket[] = [];
  for (let start = bucketStart(fromMs, granularity); start < toMs; ) {
    buckets.push(bucketLabel(start, granularity));
    start = nextBucket(start, granularity);
  }
  return buckets;
}

export interface TrendValue {
  /** Latest views of the posts published in this bucket. */
  views: number;
  posts: number;
  /** Views of every post published from the start of the range to the end of this bucket. */
  total: number;
}

export interface PlatformTrend {
  platform: Platform;
  values: TrendValue[];
}

export interface ViewsTrend {
  granularity: Granularity;
  buckets: Bucket[];
  lines: PlatformTrend[];
  /** Buckets with at least one post on any platform. */
  activeBuckets: number;
}

/**
 * The overview's daily rows as one line per platform over every bucket of the range: the views of
 * each bucket's posts (zero where nothing was published) and their running total, which the chart
 * plots. Platforms follow the contract order, so their colours never move.
 */
export function viewsTrend(
  overview: Pick<AnalyticsOverview, "from" | "to" | "daily" | "platforms">,
): ViewsTrend {
  const fromMs = Date.parse(overview.from);
  const toMs = Date.parse(overview.to);
  const granularity = granularityFor(fromMs, toMs);
  const buckets = bucketsBetween(fromMs, toMs, granularity);
  const index = new Map(buckets.map((bucket, position) => [bucket.start, position]));
  const platforms = orderPlatforms([
    ...overview.platforms.map((entry) => entry.platform),
    ...overview.daily.map((row) => row.platform),
  ]);
  const lines: PlatformTrend[] = platforms.map((platform) => ({
    platform,
    values: buckets.map(() => ({ views: 0, posts: 0, total: 0 })),
  }));
  const byPlatform = new Map(lines.map((entry) => [entry.platform, entry]));
  const active = new Set<number>();

  for (const row of overview.daily) {
    const position = index.get(bucketStart(Date.parse(`${row.date}T00:00:00Z`), granularity));
    const value =
      position === undefined ? undefined : byPlatform.get(row.platform)?.values[position];
    if (position === undefined || !value) continue;
    value.views += row.views;
    value.posts += row.posts;
    active.add(position);
  }
  for (const { values } of lines) {
    let total = 0;
    for (const value of values) {
      total += value.views;
      value.total = total;
    }
  }
  return { granularity, buckets, lines, activeBuckets: active.size };
}

/** A y scale from zero, rounded up to clean ticks. An all-zero series still gets a 0–1 axis. */
export function valueScale(max: number, height: number, ticks = 4) {
  return scaleLinear()
    .domain([0, max > 0 ? max : 1])
    .nice(ticks)
    .range([height, 0]);
}

/** Evenly spaced positions for `count` points across `width`. */
export function pointScale(count: number, width: number) {
  return scaleLinear()
    .domain([0, Math.max(1, count - 1)])
    .range([0, width]);
}

/** The index of the point nearest `x`. */
export function nearestIndex(x: number, count: number, width: number): number {
  if (count <= 1) return 0;
  const position = pointScale(count, width).invert(x);
  return Math.min(count - 1, Math.max(0, Math.round(position)));
}

/** Which of `count` ticks to label so labels stay at least `minGap` pixels apart. */
export function tickIndices(count: number, width: number, minGap = 64): number[] {
  if (count <= 0) return [];
  const room = Math.max(2, Math.floor(width / minGap) + 1);
  if (count <= room) return Array.from({ length: count }, (_, index) => index);
  const step = Math.ceil((count - 1) / (room - 1));
  const indices: number[] = [];
  for (let index = 0; index < count; index += step) indices.push(index);
  return indices;
}

/** The SVG path of a line through `values`, skipping nulls. */
export function linePath(
  values: readonly (number | null)[],
  x: (index: number) => number,
  y: (value: number) => number,
): string {
  const generator = line<number | null>()
    .defined((value) => value !== null)
    .x((_, index) => x(index))
    .y((value) => y(value ?? 0))
    .curve(curveMonotoneX);
  return generator([...values]) ?? "";
}

export interface BarLayout {
  /** Left edge of the bar for `key`. */
  x: (key: string) => number;
  /** Centre of the slot for `key`. */
  center: (key: string) => number;
  barWidth: number;
  step: number;
}

/**
 * Thin bars: at most `maxBar` wide, centred in their band, always at least `minGap` apart so
 * neighbours are separated by the surface rather than a stroke.
 */
export function barLayout(
  keys: readonly string[],
  width: number,
  maxBar = 24,
  minGap = 2,
): BarLayout {
  const band = scaleBand<string>()
    .domain(keys)
    .range([0, width])
    .paddingInner(0.3)
    .paddingOuter(0.2);
  const step = band.step();
  const barWidth = Math.max(1, Math.min(maxBar, band.bandwidth(), step - minGap));
  const offset = (band.bandwidth() - barWidth) / 2;
  return {
    x: (key) => (band(key) ?? 0) + offset,
    center: (key) => (band(key) ?? 0) + band.bandwidth() / 2,
    barWidth,
    step,
  };
}

/** A bar growing from the baseline: rounded 4px data end, square at the base. */
export function barPath(x: number, y: number, width: number, height: number, radius = 4): string {
  if (!(height > 0) || !(width > 0)) return "";
  const r = Math.min(radius, width / 2, height);
  const bottom = y + height;
  return [
    `M${x},${bottom}`,
    `V${y + r}`,
    `A${r},${r} 0 0 1 ${x + r},${y}`,
    `H${x + width - r}`,
    `A${r},${r} 0 0 1 ${x + width},${y + r}`,
    `V${bottom}`,
    "Z",
  ].join("");
}

/** Posts in publish order with a stable key and their label for the x axis. */
export function postsByDate(posts: readonly PostPerformance[]): PostPerformance[] {
  return [...posts].sort(
    (a, b) => a.publishedAt.localeCompare(b.publishedAt) || a.postId.localeCompare(b.postId),
  );
}
