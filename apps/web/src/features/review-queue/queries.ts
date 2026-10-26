import type { ContentItem, CursorPage } from "@loomcast/contracts";
import {
  type InfiniteData,
  infiniteQueryOptions,
  type QueryClient,
  queryOptions,
  useQueryClient,
} from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useLiveEvent } from "@/lib/live";

export const REVIEW_PAGE_SIZE = 50;

export const reviewQueueKeys = {
  all: ["reviews", "queue"] as const,
  list: (workspaceId: string | null) => ["reviews", "queue", workspaceId ?? "all"] as const,
};

export type ReviewQueuePages = InfiniteData<CursorPage<ContentItem>, string | undefined>;

/** Items in review: the nearest target first, items without one last, then the longest waiting. */
export function compareQueue(a: ContentItem, b: ContentItem): number {
  if (a.targetAt && b.targetAt && a.targetAt !== b.targetAt) {
    return a.targetAt.localeCompare(b.targetAt);
  }
  if (a.targetAt && !b.targetAt) return -1;
  if (!a.targetAt && b.targetAt) return 1;
  return a.updatedAt.localeCompare(b.updatedAt) || a.id.localeCompare(b.id);
}

export function reviewQueueQueryOptions(workspaceId: string | null) {
  return infiniteQueryOptions({
    queryKey: reviewQueueKeys.list(workspaceId),
    queryFn: ({ pageParam, signal }) =>
      api.request("reviews.queue", {
        query: {
          ...(workspaceId ? { workspaceId } : {}),
          limit: REVIEW_PAGE_SIZE,
          ...(pageParam ? { cursor: pageParam } : {}),
        },
        signal,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    // Live events patch the queue only while it is open; decisions taken on an item page in the
    // meantime are picked up by refetching whenever the queue opens again.
    staleTime: 0,
  });
}

/**
 * Applies a created or changed item to every loaded queue: an item in review is added or replaced
 * and the loaded rows re-sorted; anything else leaves the queue. Older copies are ignored.
 */
export function applyToQueues(queryClient: QueryClient, item: ContentItem) {
  for (const [queryKey, data] of queryClient.getQueriesData<ReviewQueuePages>({
    queryKey: reviewQueueKeys.all,
  })) {
    if (!data) continue;
    const scope = queryKey[2];
    if (scope !== "all" && scope !== item.workspaceId) continue;
    const rows = data.pages.flatMap((page) => page.items);
    const cached = rows.find((entry) => entry.id === item.id);
    if (cached && cached.updatedAt > item.updatedAt) continue;
    const others = rows.filter((entry) => entry.id !== item.id);
    if (!cached && item.state !== "review") continue;
    const next = item.state === "review" ? [...others, item].sort(compareQueue) : others;
    // Keep the page boundaries the server gave, so the next cursor still lines up.
    let offset = 0;
    const pages = data.pages.map((page, index) => {
      const last = index === data.pages.length - 1;
      const size = last ? next.length - offset : page.items.length;
      const items = next.slice(offset, offset + Math.max(0, size));
      offset += items.length;
      return { ...page, items };
    });
    queryClient.setQueryData<ReviewQueuePages>(queryKey, { ...data, pages });
  }
}

/** Keeps the review queue current with `content.item.*` events. */
export function useReviewQueueLive() {
  const queryClient = useQueryClient();
  useLiveEvent("content.item.created", (event) => applyToQueues(queryClient, event.payload.item));
  useLiveEvent("content.item.updated", (event) => applyToQueues(queryClient, event.payload.item));
}

/** A presigned URL for an asset, refetched shortly before it expires. */
export function assetUrlQueryOptions(assetId: string) {
  return queryOptions({
    queryKey: ["assets", "url", assetId, "inline"] as const,
    queryFn: ({ signal }) =>
      api.request("assets.url", {
        params: { id: assetId },
        query: { disposition: "inline" },
        signal,
      }),
    staleTime: (query) => {
      const expiresAt = query.state.data ? Date.parse(query.state.data.expiresAt) : 0;
      return Math.max(0, expiresAt - Date.now() - 60_000);
    },
    refetchInterval: (query) => {
      const expiresAt = query.state.data ? Date.parse(query.state.data.expiresAt) : 0;
      return expiresAt ? Math.max(30_000, expiresAt - Date.now() - 60_000) : false;
    },
  });
}
