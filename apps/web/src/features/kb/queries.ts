import {
  type CursorPage,
  KB_SEARCH_MAX_LIMIT,
  type KbEntry,
  type KbEntryDetail,
} from "@loomcast/contracts";
import {
  type InfiniteData,
  infiniteQueryOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import { api } from "@/lib/api";
import { filterKinds, type KbFilter } from "./kinds";

/** Entries per page of the knowledge list. */
export const KB_PAGE_SIZE = 50;

/** What a knowledge list shows: one kind or all, and at most one tag. */
export interface KbListFilter {
  kind: KbFilter;
  tag: string | null;
}

/** Knowledge-base query keys. Live events and mutations patch the same caches. */
export const kbKeys = {
  all: ["kb"] as const,
  lists: (workspaceId: string) => ["kb", "list", workspaceId] as const,
  list: (workspaceId: string, filter: KbListFilter) =>
    ["kb", "list", workspaceId, { kind: filter.kind, tag: filter.tag }] as const,
  searches: (workspaceId: string) => ["kb", "search", workspaceId] as const,
  search: (workspaceId: string, q: string, kind: KbFilter) =>
    ["kb", "search", workspaceId, { q, kind }] as const,
  tags: (workspaceId: string) => ["kb", "tags", workspaceId] as const,
  detail: (id: string) => ["kb", "detail", id] as const,
};

type KbPages = InfiniteData<CursorPage<KbEntry>, string | undefined>;

export function kbListQueryOptions(workspaceId: string, filter: KbListFilter) {
  return infiniteQueryOptions({
    queryKey: kbKeys.list(workspaceId, filter),
    queryFn: ({ pageParam, signal }) =>
      api.request("kb.list", {
        params: { workspaceId },
        query: {
          limit: KB_PAGE_SIZE,
          ...(pageParam ? { cursor: pageParam } : {}),
          ...(filter.kind === "all" ? {} : { kinds: filterKinds(filter.kind) }),
          ...(filter.tag ? { tag: filter.tag } : {}),
        },
        signal,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
}

export function kbSearchQueryOptions(workspaceId: string, q: string, kind: KbFilter) {
  return queryOptions({
    queryKey: kbKeys.search(workspaceId, q, kind),
    queryFn: ({ signal }) =>
      api.request("kb.search", {
        query: {
          q,
          workspaceId,
          limit: KB_SEARCH_MAX_LIMIT,
          ...(kind === "all" ? {} : { kinds: filterKinds(kind) }),
        },
        signal,
      }),
    select: (list) => list.items,
  });
}

export function kbTagsQueryOptions(workspaceId: string) {
  return queryOptions({
    queryKey: kbKeys.tags(workspaceId),
    queryFn: ({ signal }) => api.request("kb.tags", { params: { workspaceId }, signal }),
    select: (list) =>
      [...list.items].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag)),
  });
}

export function kbEntryQueryOptions(id: string) {
  return queryOptions({
    queryKey: kbKeys.detail(id),
    queryFn: ({ signal }) => api.request("kb.get", { params: { id }, signal }),
  });
}

/** The listed part of an entry. */
export function toKbEntry(entry: KbEntry | KbEntryDetail): KbEntry {
  const { reference: _reference, ...rest } = entry as KbEntryDetail;
  return rest;
}

/** Whether `entry` belongs in a list with `filter`. */
export function matchesFilter(entry: KbEntry, filter: KbListFilter): boolean {
  if (filter.kind !== "all" && entry.kind !== filter.kind) return false;
  return filter.tag === null || entry.tags.includes(filter.tag);
}

function filterOfKey(queryKey: readonly unknown[]): KbListFilter | null {
  const filter = queryKey[3] as Partial<KbListFilter> | undefined;
  if (!filter || typeof filter.kind !== "string") return null;
  return { kind: filter.kind, tag: filter.tag ?? null };
}

function mapPages(data: KbPages, map: (items: KbEntry[], index: number) => KbEntry[]): KbPages {
  return {
    ...data,
    pages: data.pages.map((page, index) => ({ ...page, items: map(page.items, index) })),
  };
}

/**
 * Applies a created or changed entry to every loaded list of its workspace: replaced where it is,
 * dropped where it no longer matches, and added at the top of lists it newly belongs to.
 */
export function upsertKbEntry(queryClient: QueryClient, input: KbEntry | KbEntryDetail) {
  const entry = toKbEntry(input);
  for (const [queryKey, data] of queryClient.getQueriesData<KbPages>({
    queryKey: kbKeys.lists(entry.workspaceId),
  })) {
    const filter = filterOfKey(queryKey);
    if (!data || !filter) continue;
    const present = data.pages.some((page) => page.items.some((item) => item.id === entry.id));
    const belongs = matchesFilter(entry, filter);
    let next: KbPages;
    if (present) {
      next = mapPages(data, (items) =>
        belongs
          ? items.map((item) => (item.id === entry.id ? entry : item))
          : items.filter((item) => item.id !== entry.id),
      );
    } else if (belongs) {
      next = mapPages(data, (items, index) => (index === 0 ? [entry, ...items] : items));
    } else {
      continue;
    }
    queryClient.setQueryData(queryKey, next);
  }
  void queryClient.invalidateQueries({ queryKey: kbKeys.tags(entry.workspaceId) });
  void queryClient.invalidateQueries({ queryKey: kbKeys.searches(entry.workspaceId) });
}

/** Drops a deleted entry from its workspace's lists and refetches anything showing it. */
export function removeKbEntry(queryClient: QueryClient, entryId: string, workspaceId: string) {
  for (const [queryKey, data] of queryClient.getQueriesData<KbPages>({
    queryKey: kbKeys.lists(workspaceId),
  })) {
    if (!data) continue;
    queryClient.setQueryData(
      queryKey,
      mapPages(data, (items) => items.filter((item) => item.id !== entryId)),
    );
  }
  void queryClient.invalidateQueries({ queryKey: kbKeys.tags(workspaceId) });
  void queryClient.invalidateQueries({ queryKey: kbKeys.searches(workspaceId) });
  void queryClient.invalidateQueries({ queryKey: kbKeys.detail(entryId) });
}

/**
 * Brings a cached entry detail up to date with a listed entry from a live event. A detail that
 * is behind is merged at once and refetched, since the event leaves out reference details.
 */
export function patchKbDetail(queryClient: QueryClient, entry: KbEntry) {
  const detail = queryClient.getQueryData<KbEntryDetail>(kbKeys.detail(entry.id));
  if (!detail || detail.updatedAt >= entry.updatedAt) return;
  queryClient.setQueryData<KbEntryDetail>(kbKeys.detail(entry.id), { ...detail, ...entry });
  void queryClient.invalidateQueries({ queryKey: kbKeys.detail(entry.id) });
}

/** Stores an entry the API returned: detail, lists, tags and searches. */
export function cacheKbEntry(queryClient: QueryClient, entry: KbEntryDetail) {
  queryClient.setQueryData(kbKeys.detail(entry.id), entry);
  upsertKbEntry(queryClient, entry);
}
