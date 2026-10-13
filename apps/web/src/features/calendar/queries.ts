import type { CalendarResponse, Channel, Format, List, ScheduledPost } from "@loomcast/contracts";
import {
  type QueryClient,
  queryOptions,
  useMutation,
  useQueries,
  useQueryClient,
} from "@tanstack/react-query";
import { useMemo } from "react";
import { toast } from "sonner";
import { api, errorMessage, isApiError } from "@/lib/api";
import {
  type CalendarQueryKey,
  movePost,
  type PendingMove,
  rollbackMove,
  upsertPost,
} from "./model";

/** Calendar, channel and format query keys. Moves, new posts and live events patch the same caches. */
export const calendarKeys = {
  all: ["calendar"] as const,
  ranges: ["calendar", "range"] as const,
  range: (key: CalendarQueryKey) => ["calendar", "range", key] as const,
};

/** Shared with the channel settings screens. */
export const channelKeys = {
  list: ["channels", "list"] as const,
};

export const formatKeys = {
  list: (projectId: string) => ["formats", "list", projectId] as const,
};

/** A query key with its ids sorted, so the same filter always hits the same cache entry. */
export function calendarQueryKey(
  from: string,
  to: string,
  channelIds: readonly string[],
  seriesIds: readonly string[],
): CalendarQueryKey {
  return { from, to, channelIds: [...channelIds].sort(), seriesIds: [...seriesIds].sort() };
}

export function calendarQueryOptions(key: CalendarQueryKey) {
  return queryOptions({
    queryKey: calendarKeys.range(key),
    queryFn: ({ signal }) =>
      api.request("calendar.get", {
        query: {
          from: key.from,
          to: key.to,
          ...(key.channelIds.length > 0 ? { channelIds: key.channelIds.join(",") } : {}),
          ...(key.seriesIds.length > 0 ? { seriesIds: key.seriesIds.join(",") } : {}),
        },
        signal,
      }),
  });
}

export function channelsQueryOptions() {
  return queryOptions({
    queryKey: channelKeys.list,
    queryFn: ({ signal }) => api.request("channels.list", { signal }),
    staleTime: 60_000,
  });
}

function formatsQueryOptions(projectId: string) {
  return queryOptions({
    queryKey: formatKeys.list(projectId),
    queryFn: ({ signal }) => api.request("formats.list", { params: { projectId }, signal }),
    staleTime: 60_000,
  });
}

/** The cadence time zone of each format, by format id, for the given projects. */
export function useFormatZones(projectIds: readonly string[]): Map<string, string> {
  const lists = useQueries({
    queries: projectIds.map((id) => formatsQueryOptions(id)),
    combine: (results) => results.map((result) => result.data),
  });
  return useMemo(() => {
    const zones = new Map<string, string>();
    for (const list of lists as (List<Format> | undefined)[]) {
      for (const format of list?.items ?? []) {
        zones.set(format.id, format.currentVersion.rules.cadence.tz);
      }
    }
    return zones;
  }, [lists]);
}

// Cache patching --------------------------------------------------------------------

function keyOf(queryKey: readonly unknown[]): CalendarQueryKey | null {
  const key = queryKey[2] as CalendarQueryKey | undefined;
  return key && typeof key.from === "string" && Array.isArray(key.channelIds) ? key : null;
}

/** Applies `update` to every loaded calendar range. */
export function updateCalendars(
  queryClient: QueryClient,
  update: (data: CalendarResponse, key: CalendarQueryKey) => CalendarResponse,
) {
  for (const [queryKey, data] of queryClient.getQueriesData<CalendarResponse>({
    queryKey: calendarKeys.ranges,
  })) {
    const key = keyOf(queryKey);
    if (!data || !key) continue;
    const next = update(data, key);
    if (next !== data) queryClient.setQueryData(queryKey, next);
  }
}

/** A post from the API or a live event, applied to every loaded range. */
export function applyPost(queryClient: QueryClient, post: ScheduledPost) {
  updateCalendars(queryClient, (data, key) => upsertPost(data, post, key));
}

/** Replaces or adds a channel in the cached list. */
export function applyChannel(queryClient: QueryClient, channel: Channel) {
  queryClient.setQueryData<List<Channel>>(channelKeys.list, (list) => {
    if (!list) return list;
    const items = list.items.some((entry) => entry.id === channel.id)
      ? list.items.map((entry) => (entry.id === channel.id ? channel : entry))
      : [...list.items, channel];
    return { items };
  });
}

// Mutations -------------------------------------------------------------------------

export interface RescheduleInput {
  post: ScheduledPost;
  scheduledAt: string;
}

/**
 * Moves a post. The calendars show the new time at once; a failure puts the post back and says
 * why. A `409` means the post changed elsewhere (or started publishing): the calendars refetch.
 */
export function useReschedulePost() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ post, scheduledAt }: RescheduleInput) =>
      api.request("scheduledPosts.reschedule", {
        params: { id: post.id },
        body: { scheduledAt, expectedUpdatedAt: post.updatedAt },
      }),
    onMutate: async ({ post, scheduledAt }): Promise<PendingMove> => {
      const move: PendingMove = { previous: post, scheduledAt };
      // A refetch in flight would bring the old time back. Cancelling restores the data from
      // before that fetch, so it finishes first; the answer or the live event corrects the rest.
      await queryClient.cancelQueries({ queryKey: calendarKeys.ranges });
      updateCalendars(queryClient, (data) => movePost(data, post.id, scheduledAt));
      return move;
    },
    onSuccess: (post) => applyPost(queryClient, post),
    onError: (error, _input, move) => {
      if (move) updateCalendars(queryClient, (data) => rollbackMove(data, move));
      if (isApiError(error, 409)) {
        toast.error(
          error.code === "post_not_editable"
            ? "This post can't move any more. It is publishing, published or cancelled."
            : "This post changed somewhere else. The calendar now shows the latest times.",
        );
        void queryClient.invalidateQueries({ queryKey: calendarKeys.ranges });
        return;
      }
      toast.error("Couldn't move the post", { description: errorMessage(error) });
    },
  });
}
