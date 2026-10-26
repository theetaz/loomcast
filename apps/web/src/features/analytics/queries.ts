import { keepPreviousData, queryOptions, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useLiveEvent, useLiveReconnect } from "@/lib/live";
import { queryKeys } from "@/lib/query-keys";

export function overviewQueryOptions(query: { from: string; to: string; workspaceId?: string }) {
  return queryOptions({
    queryKey: queryKeys.analytics.overview(query),
    queryFn: ({ signal }) => api.request("analytics.overview", { query, signal }),
    // A new range keeps the previous charts on screen, dimmed, until the new numbers arrive.
    placeholderData: keepPreviousData,
  });
}

export function seriesAnalyticsQueryOptions(id: string, query: { from?: string; to?: string }) {
  return queryOptions({
    queryKey: queryKeys.analytics.series(id, query),
    queryFn: ({ signal }) => api.request("analytics.series", { params: { id }, query, signal }),
    placeholderData: keepPreviousData,
  });
}

export function itemAnalyticsQueryOptions(id: string) {
  return queryOptions({
    queryKey: queryKeys.analytics.item(id),
    queryFn: ({ signal }) => api.request("analytics.item", { params: { id }, signal }),
  });
}

/**
 * Refetches the analytics on screen when a post gets a new capture. Captures come a few times per
 * post over its first month, so refetching is cheaper than patching aggregates by hand.
 */
export function useAnalyticsLive() {
  const queryClient = useQueryClient();
  const refresh = () => void queryClient.invalidateQueries({ queryKey: queryKeys.analytics.all });
  useLiveEvent("post.metrics.updated", refresh);
  useLiveReconnect(refresh);
}
