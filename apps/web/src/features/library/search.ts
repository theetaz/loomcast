import {
  CONTENT_SEARCH_MAX_LENGTH,
  IdSchema,
  PIPELINE_STATES,
  type PipelineState,
} from "@loomcast/contracts";
import { z } from "zod";

/** Columns the table sorts by. */
export const LIBRARY_SORT_KEYS = [
  "title",
  "series",
  "state",
  "version",
  "target",
  "duration",
  "updated",
] as const;
export type LibrarySortKey = (typeof LIBRARY_SORT_KEYS)[number];

/** `title` sorts ascending, `-title` descending. */
const LIBRARY_SORTS = LIBRARY_SORT_KEYS.flatMap((key) => [key, `-${key}`] as const);
export type LibrarySort = (typeof LIBRARY_SORTS)[number];

/** Newest change first, like the API returns them. */
export const DEFAULT_LIBRARY_SORT: LibrarySort = "-updated";

/**
 * Pipeline states from a comma-separated value (`states=script,voice`), in pipeline order without
 * repeats. Unknown states are dropped.
 */
export function parseStates(value: string | null | undefined): PipelineState[] {
  if (!value) return [];
  const wanted = new Set(value.split(",").map((part) => part.trim()));
  return PIPELINE_STATES.filter((state) => wanted.has(state));
}

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** A calendar day as `YYYY-MM-DD`, as a date input gives it. */
export function isDay(value: unknown): value is string {
  if (typeof value !== "string" || !DAY_PATTERN.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

// The router parses search values as JSON first, so `q=2026` arrives as a number.
const textParam = z
  .union([z.string(), z.number()])
  .transform((value) => String(value).trim().slice(0, CONTENT_SEARCH_MAX_LENGTH))
  .pipe(z.string().min(1));

const statesParam = z
  .string()
  .transform((value) => parseStates(value).join(","))
  .pipe(z.string().min(1));

const dayParam = z.string().refine(isDay);

/**
 * The library's filters and sort, as they appear in the address. Every value is optional and an
 * invalid one is dropped rather than failing the page, so an old or edited link still opens.
 */
export const LibrarySearchSchema = z
  .object({
    /** Comma-separated pipeline states; none means every state but archived. */
    states: statesParam.optional().catch(undefined),
    series: IdSchema.optional().catch(undefined),
    /** First and last target day, inclusive, in the browser's time zone. */
    from: dayParam.optional().catch(undefined),
    to: dayParam.optional().catch(undefined),
    q: textParam.optional().catch(undefined),
    sort: z.enum(LIBRARY_SORTS).optional().catch(undefined),
  })
  // A range that ends before it starts keeps only its start.
  .transform((search) =>
    search.from && search.to && search.to < search.from ? { ...search, to: undefined } : search,
  );
export type LibrarySearch = z.infer<typeof LibrarySearchSchema>;

/** What the library shows, with the address's defaults filled in. */
export interface LibraryFilter {
  /** The workspace whose library this is; null for a search across every workspace. */
  workspaceId: string | null;
  states: PipelineState[];
  seriesId: string | null;
  from: string | null;
  to: string | null;
  q: string;
}

export function filterFromSearch(search: LibrarySearch, workspaceId: string | null): LibraryFilter {
  return {
    workspaceId,
    states: parseStates(search.states),
    seriesId: search.series ?? null,
    from: search.from ?? null,
    to: search.to ?? null,
    q: search.q ?? "",
  };
}

/** The address for a filter and sort; defaults are left out so plain links stay plain. */
export function searchFromFilter(filter: LibraryFilter, sort: LibrarySort): LibrarySearch {
  return {
    ...(filter.states.length > 0 ? { states: filter.states.join(",") } : {}),
    ...(filter.seriesId ? { series: filter.seriesId } : {}),
    ...(filter.from ? { from: filter.from } : {}),
    ...(filter.to ? { to: filter.to } : {}),
    ...(filter.q ? { q: filter.q } : {}),
    ...(sort === DEFAULT_LIBRARY_SORT ? {} : { sort }),
  };
}

export function hasFilters(filter: LibraryFilter): boolean {
  return (
    filter.states.length > 0 ||
    filter.seriesId !== null ||
    filter.from !== null ||
    filter.to !== null ||
    filter.q !== ""
  );
}

/** The start of a local calendar day, as an ISO timestamp. */
export function startOfDay(day: string): string {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  return new Date(year, month - 1, date).toISOString();
}

/** The last millisecond of a local calendar day, as an ISO timestamp. */
export function endOfDay(day: string): string {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  return new Date(year, month - 1, date + 1, 0, 0, 0, -1).toISOString();
}

/** The `content.list` query for a filter. States go comma-separated, as the contracts expect. */
export function contentListQuery(filter: LibraryFilter) {
  return {
    ...(filter.workspaceId ? { workspaceId: filter.workspaceId } : {}),
    ...(filter.states.length > 0 ? { states: filter.states.join(",") } : {}),
    ...(filter.seriesId ? { seriesId: filter.seriesId } : {}),
    ...(filter.q ? { q: filter.q } : {}),
    ...(filter.from ? { targetFrom: startOfDay(filter.from) } : {}),
    ...(filter.to ? { targetTo: endOfDay(filter.to) } : {}),
  };
}

export function parseSort(sort: LibrarySort): { key: LibrarySortKey; descending: boolean } {
  return sort.startsWith("-")
    ? { key: sort.slice(1) as LibrarySortKey, descending: true }
    : { key: sort as LibrarySortKey, descending: false };
}
