import { IdSchema, MAX_CALENDAR_FILTER_IDS } from "@loomcast/contracts";
import { z } from "zod";

// Loaded with the route definition (not split), so it stays free of date libraries.

export const CALENDAR_VIEWS = ["week", "month"] as const;
export type CalendarView = (typeof CALENDAR_VIEWS)[number];

/** Which clock the grid follows: the browser's, or the time zone of the filtered series. */
export const CALENDAR_ZONES = ["local", "series"] as const;
export type CalendarZoneMode = (typeof CALENDAR_ZONES)[number];

const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A calendar date as `YYYY-MM-DD`, valid in every time zone. */
export function isDayKey(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = DAY_PATTERN.exec(value);
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toISOString().slice(0, 10) === value;
}

/** Comma-separated ids in order of appearance, without repeats; invalid ids are dropped. */
export function parseIds(value: string | null | undefined): string[] {
  if (!value) return [];
  const ids = value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => IdSchema.safeParse(part).success);
  return [...new Set(ids)].slice(0, MAX_CALENDAR_FILTER_IDS);
}

const idsParam = z
  .string()
  .transform((value) => parseIds(value).join(","))
  .pipe(z.string().min(1));

/**
 * The calendar's address: the view, the day it shows, the channel and series filters and the
 * clock. Every value is optional and an invalid one is dropped, so an edited link still opens.
 */
export const CalendarSearchSchema = z.object({
  view: z.enum(CALENDAR_VIEWS).optional().catch(undefined),
  /** Any day of the period shown; today when left out. */
  date: z.string().refine(isDayKey).optional().catch(undefined),
  /** Comma-separated channel ids. */
  channels: idsParam.optional().catch(undefined),
  /** Comma-separated series ids. */
  series: idsParam.optional().catch(undefined),
  zone: z.enum(CALENDAR_ZONES).optional().catch(undefined),
});
export type CalendarSearch = z.infer<typeof CalendarSearchSchema>;
