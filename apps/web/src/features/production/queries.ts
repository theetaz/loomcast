import type { ContentProgress, List } from "@loomcast/contracts";
import { type QueryClient, queryOptions, useQueryClient } from "@tanstack/react-query";
import { api, isApiError } from "@/lib/api";
import { useLiveEvent } from "@/lib/live";

/** Progress query keys. `content.progress.updated` patches the same caches. */
export const progressKeys = {
  all: ["progress"] as const,
  list: (workspaceId: string) => ["progress", "list", workspaceId] as const,
  item: (itemId: string) => ["progress", "item", itemId] as const,
};

export function progressListQueryOptions(workspaceId: string) {
  return queryOptions({
    queryKey: progressKeys.list(workspaceId),
    queryFn: ({ signal }) => api.request("progress.list", { params: { workspaceId }, signal }),
    select: (list: List<ContentProgress>) => list.items,
  });
}

/** One item's progress; null when none was reported (404). */
export function progressItemQueryOptions(itemId: string) {
  return queryOptions({
    queryKey: progressKeys.item(itemId),
    queryFn: async ({ signal }) => {
      try {
        return await api.request("progress.get", { params: { id: itemId }, signal });
      } catch (error) {
        if (isApiError(error) && error.status === 404) return null;
        throw error;
      }
    },
  });
}

/** Puts one item's progress into the workspace list and the item cache, newest first. */
export function upsertProgress(queryClient: QueryClient, progress: ContentProgress) {
  queryClient.setQueryData(progressKeys.item(progress.itemId), progress);
  queryClient.setQueryData<List<ContentProgress>>(
    progressKeys.list(progress.workspaceId),
    (list) => {
      if (list === undefined) return list;
      const others = list.items.filter((item) => item.itemId !== progress.itemId);
      return { ...list, items: [progress, ...others] };
    },
  );
}

/** Keeps progress caches current while a page shows them. */
export function useProgressLive() {
  const queryClient = useQueryClient();
  useLiveEvent("content.progress.updated", (event) =>
    upsertProgress(queryClient, event.payload.progress),
  );
}
