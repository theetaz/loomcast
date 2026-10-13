import { type ContentItem, PIPELINE_STATES, type PipelineState } from "@loomcast/contracts";
import { type LibrarySort, type LibrarySortKey, parseSort } from "./search";

/** Board columns when no state is filtered: the whole pipeline but the archive. */
export const BOARD_STATES: readonly PipelineState[] = PIPELINE_STATES.filter(
  (state) => state !== "archived",
);

export interface BoardColumn {
  state: PipelineState;
  items: ContentItem[];
}

/**
 * Groups items into one column per state, in pipeline order. `states` picks the columns (the
 * board's filter); without it every state but archived gets one. Items keep their list order.
 */
export function groupByState(
  items: readonly ContentItem[],
  states: readonly PipelineState[] = [],
): BoardColumn[] {
  const columns =
    states.length > 0 ? PIPELINE_STATES.filter((s) => states.includes(s)) : BOARD_STATES;
  const byState = new Map<PipelineState, ContentItem[]>(columns.map((state) => [state, []]));
  for (const item of items) byState.get(item.state)?.push(item);
  return columns.map((state) => ({ state, items: byState.get(state) ?? [] }));
}

/** The first sort for a column: names A to Z, the pipeline in order, the soonest target, the rest largest or newest first. */
export const DEFAULT_DIRECTION: Record<LibrarySortKey, "asc" | "desc"> = {
  title: "asc",
  series: "asc",
  state: "asc",
  version: "desc",
  target: "asc",
  duration: "desc",
  updated: "desc",
};

/** The sort after choosing `key`: the column's first direction, or the other one if already sorted by it. */
export function nextSort(current: LibrarySort, key: LibrarySortKey): LibrarySort {
  const { key: currentKey, descending } = parseSort(current);
  if (currentKey === key) return (descending ? key : `-${key}`) as LibrarySort;
  return (DEFAULT_DIRECTION[key] === "desc" ? `-${key}` : key) as LibrarySort;
}

type SortValue = string | number | null;

function sortValue(
  item: ContentItem,
  key: LibrarySortKey,
  seriesName: (id: string) => string | undefined,
): SortValue {
  switch (key) {
    case "title":
      return item.title.toLocaleLowerCase();
    case "series":
      return item.seriesId ? (seriesName(item.seriesId)?.toLocaleLowerCase() ?? null) : null;
    case "state":
      return PIPELINE_STATES.indexOf(item.state);
    case "version":
      return item.versionNo;
    case "target":
      return item.targetAt ? Date.parse(item.targetAt) : null;
    case "duration":
      return item.durationMs;
    case "updated":
      return Date.parse(item.updatedAt);
  }
}

/**
 * Sorts loaded items by a column. Empty values go last in either direction; ties keep the most
 * recently updated first.
 */
export function sortItems(
  items: readonly ContentItem[],
  sort: LibrarySort,
  seriesName: (id: string) => string | undefined = () => undefined,
): ContentItem[] {
  const { key, descending } = parseSort(sort);
  const direction = descending ? -1 : 1;
  return items
    .map((item) => ({ item, value: sortValue(item, key, seriesName) }))
    .sort((a, b) => {
      if (a.value === null || b.value === null) {
        if (a.value === b.value) return b.item.updatedAt.localeCompare(a.item.updatedAt);
        return a.value === null ? 1 : -1;
      }
      const order =
        typeof a.value === "string" && typeof b.value === "string"
          ? a.value.localeCompare(b.value)
          : Number(a.value) - Number(b.value);
      return order * direction || b.item.updatedAt.localeCompare(a.item.updatedAt);
    })
    .map(({ item }) => item);
}
