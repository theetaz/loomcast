import type {
  ContentItem,
  ContentItemDetail,
  CreateContentItemRequest,
  CursorPage,
  Project,
  Series,
} from "@loomcast/contracts";
import {
  type InfiniteData,
  infiniteQueryOptions,
  type QueryClient,
  queryOptions,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useMemo } from "react";
import { projectsQueryOptions } from "@/features/projects/queries";
import { api } from "@/lib/api";
import { contentListQuery, endOfDay, type LibraryFilter, startOfDay } from "./search";

/** Items per page of the library. */
export const LIBRARY_PAGE_SIZE = 50;

/** Content and series query keys. Live events and mutations patch the same caches. */
export const contentKeys = {
  all: ["content"] as const,
  lists: ["content", "list"] as const,
  list: (filter: LibraryFilter) => ["content", "list", filter] as const,
  detail: (id: string) => ["content", "detail", id] as const,
};

/** Raw `series.list` pages by project (every status), shared by every screen that names series. */
export const seriesKeys = {
  all: ["series"] as const,
  list: (projectId: string) => ["series", "list", projectId] as const,
};

export type ContentPages = InfiniteData<CursorPage<ContentItem>, string | undefined>;

export function contentListQueryOptions(filter: LibraryFilter) {
  return infiniteQueryOptions({
    queryKey: contentKeys.list(filter),
    queryFn: ({ pageParam, signal }) =>
      api.request("content.list", {
        query: {
          ...contentListQuery(filter),
          limit: LIBRARY_PAGE_SIZE,
          ...(pageParam ? { cursor: pageParam } : {}),
        },
        signal,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
}

export function contentItemQueryOptions(id: string) {
  return queryOptions({
    queryKey: contentKeys.detail(id),
    queryFn: ({ signal }) => api.request("content.get", { params: { id }, signal }),
  });
}

export function seriesListQueryOptions(projectId: string) {
  return queryOptions({
    queryKey: seriesKeys.list(projectId),
    queryFn: ({ signal }) => api.request("series.list", { params: { projectId }, signal }),
    staleTime: 60_000,
  });
}

export interface SeriesOption {
  series: Series;
  project: Project | null;
}

/**
 * The series the library can name and filter by: those of one project, or of every project when
 * the library spans them. Sorted by project, then name.
 */
export function useSeriesOptions(projectId: string | null): {
  options: SeriesOption[];
  byId: Map<string, Series>;
} {
  const projects = useQuery({ ...projectsQueryOptions(), enabled: projectId === null });
  const projectIds = projectId ? [projectId] : (projects.data ?? []).map((project) => project.id);
  const lists = useQueries({
    queries: projectIds.map((id) => seriesListQueryOptions(id)),
    combine: (results) => results.map((result) => result.data),
  });

  return useMemo(() => {
    const projectById = new Map((projects.data ?? []).map((project) => [project.id, project]));
    const options: SeriesOption[] = [];
    for (const list of lists) {
      for (const series of list?.items ?? []) {
        options.push({ series, project: projectById.get(series.projectId) ?? null });
      }
    }
    options.sort(
      (a, b) =>
        (a.project?.name ?? "").localeCompare(b.project?.name ?? "") ||
        a.series.name.localeCompare(b.series.name),
    );
    return { options, byId: new Map(options.map((option) => [option.series.id, option.series])) };
  }, [projects.data, lists]);
}

// Live patching -------------------------------------------------------------------

/**
 * Whether `item` belongs in a list with `filter`. Text search is the server's to decide, so a
 * searched list answers `null`: the item may or may not match.
 */
export function matchesFilter(item: ContentItem, filter: LibraryFilter): boolean | null {
  if (filter.projectId && item.projectId !== filter.projectId) return false;
  if (filter.states.length > 0 ? !filter.states.includes(item.state) : item.state === "archived") {
    return false;
  }
  if (filter.seriesId && item.seriesId !== filter.seriesId) return false;
  if (filter.from || filter.to) {
    if (!item.targetAt) return false;
    const target = Date.parse(item.targetAt);
    if (filter.from && target < Date.parse(startOfDay(filter.from))) return false;
    if (filter.to && target > Date.parse(endOfDay(filter.to))) return false;
  }
  if (filter.q) return null;
  return true;
}

function filterOfKey(queryKey: readonly unknown[]): LibraryFilter | null {
  const filter = queryKey[2] as LibraryFilter | undefined;
  return filter && Array.isArray(filter.states) ? filter : null;
}

function mapPages(
  data: ContentPages,
  map: (items: ContentItem[], index: number) => ContentItem[],
): ContentPages {
  return {
    ...data,
    pages: data.pages.map((page, index) => ({ ...page, items: map(page.items, index) })),
  };
}

/**
 * Applies a created or changed item to every loaded library list: replaced where it is, dropped
 * where it no longer matches, and added at the top of lists it newly belongs to (lists are newest
 * change first). An older copy than the cached one is ignored. Searched lists that may now match
 * are refetched, since only the server knows what a search finds.
 */
export function upsertContentItem(queryClient: QueryClient, item: ContentItem) {
  for (const [queryKey, data] of queryClient.getQueriesData<ContentPages>({
    queryKey: contentKeys.lists,
  })) {
    const filter = filterOfKey(queryKey);
    if (!data || !filter) continue;
    const cached = data.pages.flatMap((page) => page.items).find((entry) => entry.id === item.id);
    if (cached && cached.updatedAt > item.updatedAt) continue;
    const belongs = matchesFilter(item, filter);
    let next: ContentPages;
    if (cached) {
      next =
        belongs === false
          ? mapPages(data, (items) => items.filter((entry) => entry.id !== item.id))
          : mapPages(data, (items) => items.map((entry) => (entry.id === item.id ? item : entry)));
    } else if (belongs === true) {
      next = mapPages(data, (items, index) => (index === 0 ? [item, ...items] : items));
    } else {
      if (belongs === null) void queryClient.invalidateQueries({ queryKey, exact: true });
      continue;
    }
    queryClient.setQueryData(queryKey, next);
  }

  const detail = queryClient.getQueryData<ContentItemDetail>(contentKeys.detail(item.id));
  if (detail && detail.item.updatedAt <= item.updatedAt) {
    queryClient.setQueryData<ContentItemDetail>(contentKeys.detail(item.id), {
      ...detail,
      item,
    });
    // The event carries the item only; the current version and the job come with a refetch.
    if (detail.item.currentVersionId !== item.currentVersionId) {
      void queryClient.invalidateQueries({ queryKey: contentKeys.detail(item.id) });
    }
  }
}

/** Every loaded library item, for lookups across lists. */
export function cachedContentItems(queryClient: QueryClient): ContentItem[] {
  return queryClient
    .getQueriesData<ContentPages>({ queryKey: contentKeys.lists })
    .flatMap(([, data]) => data?.pages.flatMap((page) => page.items) ?? []);
}

// Mutations -----------------------------------------------------------------------

export function useCreateIdea() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, body }: { projectId: string; body: CreateContentItemRequest }) =>
      api.request("content.create", { params: { projectId }, body }),
    onSuccess: (detail) => {
      queryClient.setQueryData(contentKeys.detail(detail.item.id), detail);
      upsertContentItem(queryClient, detail.item);
    },
  });
}

/** Starts production up to review; the item's state follows through live events. */
export function useProduceThroughReview() {
  return useMutation({
    mutationFn: (item: ContentItem) =>
      api.request("content.actions", {
        params: { id: item.id },
        body: { action: "produce", through: "review" },
      }),
  });
}

export function useArchiveItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (item: ContentItem) => api.request("content.archive", { params: { id: item.id } }),
    onSuccess: (item) => upsertContentItem(queryClient, item),
  });
}
