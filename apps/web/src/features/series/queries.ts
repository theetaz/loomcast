import type { ContentItem, List, PipelineState, Series } from "@loomcast/contracts";
import { type QueryClient, queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { seriesKeys } from "@/features/library/queries";
import type { LibraryFilter } from "@/features/library/search";
import { api } from "@/lib/api";

/** One series, under the same root as the shared list (`["series", "list", projectId]`). */
export const seriesDetailKey = (id: string) => [...seriesKeys.all, "detail", id] as const;

export function seriesQueryOptions(id: string) {
  return queryOptions({
    queryKey: seriesDetailKey(id),
    queryFn: ({ signal }) => api.request("series.get", { params: { id }, signal }),
  });
}

/** Puts a changed series into its detail and its project's list. */
export function cacheSeries(queryClient: QueryClient, series: Series) {
  queryClient.setQueryData(seriesDetailKey(series.id), series);
  queryClient.setQueryData<List<Series>>(seriesKeys.list(series.projectId), (list) => {
    if (!list) return list;
    const exists = list.items.some((entry) => entry.id === series.id);
    return {
      items: exists
        ? list.items.map((entry) => (entry.id === series.id ? series : entry))
        : [...list.items, series].sort((a, b) => a.name.localeCompare(b.name)),
    };
  });
}

export type SeriesStatusAction = "pause" | "resume" | "archive";

const ACTION_ROUTES = {
  pause: "series.pause",
  resume: "series.resume",
  archive: "series.archive",
} as const;

/** Pauses, resumes or archives a series. */
export function useSeriesStatus() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ series, action }: { series: Series; action: SeriesStatusAction }) =>
      api.request(ACTION_ROUTES[action], { params: { id: series.id } }),
    onSuccess: (series) => cacheSeries(queryClient, series),
  });
}

export function useCreateSeries() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      projectId,
      name,
      formatId,
    }: {
      projectId: string;
      name: string;
      formatId: string;
    }) => api.request("series.create", { params: { projectId }, body: { name, formatId } }),
    onSuccess: (series) => cacheSeries(queryClient, series),
  });
}

/** Switches a series to another format of its project. */
export function useSetSeriesFormat() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ series, formatId }: { series: Series; formatId: string }) =>
      api.request("series.update", { params: { id: series.id }, body: { formatId } }),
    onSuccess: (series) => cacheSeries(queryClient, series),
  });
}

/** States of items still on their way to publishing. */
export const UPCOMING_STATES: PipelineState[] = [
  "idea",
  "script",
  "storyboard",
  "voice",
  "render",
  "review",
  "approved",
  "scheduled",
];

/**
 * The library filter for a project's (or one series') unpublished items. It goes through the
 * library's list cache, so `content.*` live events keep it current.
 */
export function upcomingFilter(projectId: string, seriesId: string | null = null): LibraryFilter {
  return { projectId, states: UPCOMING_STATES, seriesId, from: null, to: null, q: "" };
}

/** Items by target time (soonest first, undated last), then most recently changed. */
export function compareUpcoming(a: ContentItem, b: ContentItem): number {
  if (a.targetAt && b.targetAt) return a.targetAt.localeCompare(b.targetAt);
  if (a.targetAt) return -1;
  if (b.targetAt) return 1;
  return b.updatedAt.localeCompare(a.updatedAt);
}

/** Upcoming items grouped by series, each sorted with `compareUpcoming`. */
export function upcomingBySeries(items: readonly ContentItem[]): Map<string, ContentItem[]> {
  const groups = new Map<string, ContentItem[]>();
  for (const item of items) {
    if (!item.seriesId || !UPCOMING_STATES.includes(item.state)) continue;
    const group = groups.get(item.seriesId) ?? [];
    group.push(item);
    groups.set(item.seriesId, group);
  }
  for (const group of groups.values()) group.sort(compareUpcoming);
  return groups;
}
