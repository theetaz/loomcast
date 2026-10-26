import { z } from "zod";

const DAY_MS = 24 * 60 * 60_000;

/** Ranges the overview offers, in days, ending with today (UTC). */
export const OVERVIEW_RANGES = {
  "7d": { days: 7, label: "Last 7 days" },
  "30d": { days: 30, label: "Last 30 days" },
  "90d": { days: 90, label: "Last 90 days" },
  "12m": { days: 365, label: "Last 12 months" },
} as const;
export type OverviewRange = keyof typeof OVERVIEW_RANGES;
export const DEFAULT_OVERVIEW_RANGE: OverviewRange = "30d";

/** The series page adds everything since the series started. */
export const SERIES_RANGES = {
  all: { days: null, label: "All time" },
  "90d": { days: 90, label: "Last 90 days" },
  "12m": { days: 365, label: "Last 12 months" },
} as const;
export type SeriesRange = keyof typeof SERIES_RANGES;
export const DEFAULT_SERIES_RANGE: SeriesRange = "all";

const overviewRanges = Object.keys(OVERVIEW_RANGES) as [OverviewRange, ...OverviewRange[]];
const seriesRanges = Object.keys(SERIES_RANGES) as [SeriesRange, ...SeriesRange[]];

/** `/w/<workspace>/analytics?range=`. Unknown values fall back rather than fail. */
export const OverviewSearchSchema = z.object({
  range: z.enum(overviewRanges).optional().catch(undefined),
});
export type OverviewSearch = z.infer<typeof OverviewSearchSchema>;

/** `/analytics/series/:id?range=`. */
export const SeriesSearchSchema = z.object({
  range: z.enum(seriesRanges).optional().catch(undefined),
});
export type SeriesSearch = z.infer<typeof SeriesSearchSchema>;

/** The start of the UTC day after `now`: ranges end there, so today counts in full. */
export function endOfUtcToday(now: number): number {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
}

/**
 * `[from, to)` covering the last `days` UTC days including today. Stable through a day, so the
 * query key only changes when the range or the date does.
 */
export function rangeOfDays(days: number, now: number = Date.now()): { from: string; to: string } {
  const to = endOfUtcToday(now);
  return { from: new Date(to - days * DAY_MS).toISOString(), to: new Date(to).toISOString() };
}

export function overviewRange(range: OverviewRange, now: number = Date.now()) {
  return rangeOfDays(OVERVIEW_RANGES[range].days, now);
}

/** The series query for a range; `all` sends no bounds. */
export function seriesRange(range: SeriesRange, now: number = Date.now()) {
  const { days } = SERIES_RANGES[range];
  return days === null ? {} : rangeOfDays(days, now);
}
