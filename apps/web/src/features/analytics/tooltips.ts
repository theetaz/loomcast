import type { PostMetrics, PostPerformance } from "@loomcast/contracts";
import {
  formatDay,
  formatFullCount,
  formatMetric,
  formatMoment,
  formatWatch,
  type MetricKey,
  plural,
} from "./format";
import { PLATFORM_LABELS, platformColor } from "./platforms";
import type { ViewsTrend } from "./scales";

// What a data point says, once: the tooltip shows it, the point's accessible name reads it, and the
// table view prints the same formatted values.

export interface TooltipRow {
  id: string;
  /** The series colour, for the row's line key. */
  color: string;
  /** Leads the row: the number the reader came for. */
  value: string;
  label: string;
}

export interface TooltipContent {
  title: string;
  rows: TooltipRow[];
}

/** The accessible name of a point: `Oct 3: 1,204 views, Instagram · 2 posts; …`. */
export function tooltipText({ title, rows }: TooltipContent): string {
  if (rows.length === 0) return title;
  return `${title}: ${rows.map((row) => `${row.value}, ${row.label}`).join("; ")}`;
}

/** Every platform's running total at one bucket of the trend, and what that bucket added. */
export function trendTooltip(trend: ViewsTrend, index: number): TooltipContent {
  const bucket = trend.buckets[index];
  return {
    title: bucket?.label ?? "",
    rows: trend.lines.map(({ platform, values }) => {
      const value = values[index] ?? { views: 0, posts: 0, total: 0 };
      const added =
        value.posts > 0
          ? `+${formatFullCount(value.views)} from ${plural(value.posts, "post")}`
          : "no posts";
      return {
        id: platform,
        color: platformColor(platform),
        value: formatFullCount(value.total),
        label: `${PLATFORM_LABELS[platform]} · ${added}`,
      };
    }),
  };
}

export type PostMeasure = "views" | "avgWatchMs";

/** A post's value on a per-post chart, as the table prints it. */
export function postMeasure(post: PostPerformance, measure: PostMeasure): string {
  const value = post.metrics?.[measure] ?? null;
  if (measure === "avgWatchMs") return value === null ? "Not reported" : formatWatch(value);
  return value === null ? "Not measured yet" : `${formatFullCount(value)} views`;
}

/** One post on the series charts. */
export function postTooltip(post: PostPerformance, measure: PostMeasure): TooltipContent {
  return {
    title: post.title,
    rows: [
      {
        id: post.postId,
        color: platformColor(post.platform),
        value: postMeasure(post, measure),
        label: `${PLATFORM_LABELS[post.platform]} · ${formatDay(Date.parse(post.publishedAt), true)}`,
      },
    ],
  };
}

/** One capture on a metric's sparkline. */
export function captureTooltip(
  capture: PostMetrics,
  key: MetricKey,
  label: string,
  color: string,
): TooltipContent {
  const value = capture[key];
  return {
    title: formatMoment(capture.capturedAt),
    rows: [
      {
        id: key,
        color,
        value: value === null ? "Not reported" : formatMetric(key, value, true),
        label,
      },
    ],
  };
}
