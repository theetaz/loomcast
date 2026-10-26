import type {
  CalendarResponse,
  Channel,
  ContentItem,
  Format,
  List,
  PostOptions,
  ScheduledPost,
} from "@loomcast/contracts";
import {
  type QueryClient,
  queryOptions,
  useMutation,
  useQueries,
  useQueryClient,
} from "@tanstack/react-query";
import { useMemo } from "react";
import { toast } from "sonner";
import { contentKeys, upsertContentItem } from "@/features/library/queries";
import { api, errorMessage, isApiError } from "@/lib/api";
import {
  type CalendarQueryKey,
  movePost,
  type PendingMove,
  rollbackMove,
  upsertPost,
} from "./model";

/** Calendar and format query keys (channels: `features/channels/queries`). Moves, new posts and live events patch the same caches. */
export const calendarKeys = {
  all: ["calendar"] as const,
  ranges: ["calendar", "range"] as const,
  range: (key: CalendarQueryKey) => ["calendar", "range", key] as const,
  approved: (seriesId: string) => ["calendar", "approved", seriesId] as const,
};

export const formatKeys = {
  list: (workspaceId: string) => ["formats", "list", workspaceId] as const,
};

/**
 * A query key with its ids sorted, so the same filter always hits the same cache entry. It names
 * the workspace, so one workspace's calendar never shows another's cache.
 */
export function calendarQueryKey(
  from: string,
  to: string,
  channelIds: readonly string[],
  seriesIds: readonly string[],
  workspaceId?: string,
): CalendarQueryKey {
  return {
    ...(workspaceId ? { workspaceId } : {}),
    from,
    to,
    channelIds: [...channelIds].sort(),
    seriesIds: [...seriesIds].sort(),
  };
}

export function calendarQueryOptions(key: CalendarQueryKey) {
  return queryOptions({
    queryKey: calendarKeys.range(key),
    queryFn: ({ signal }) =>
      api.request("calendar.get", {
        query: {
          ...(key.workspaceId ? { workspaceId: key.workspaceId } : {}),
          from: key.from,
          to: key.to,
          ...(key.channelIds.length > 0 ? { channelIds: key.channelIds.join(",") } : {}),
          ...(key.seriesIds.length > 0 ? { seriesIds: key.seriesIds.join(",") } : {}),
        },
        signal,
      }),
  });
}

function formatsQueryOptions(workspaceId: string) {
  return queryOptions({
    queryKey: formatKeys.list(workspaceId),
    queryFn: ({ signal }) => api.request("formats.list", { params: { workspaceId }, signal }),
    staleTime: 60_000,
  });
}

/** Approved items of a series, for filling an open slot. */
export function approvedItemsQueryOptions(seriesId: string) {
  return queryOptions({
    queryKey: calendarKeys.approved(seriesId),
    queryFn: ({ signal }) =>
      api.request("content.list", {
        query: { seriesId, states: "approved,scheduled", limit: 100 },
        signal,
      }),
  });
}

/** The cadence time zone of each format, by format id, for the given workspaces. */
export function useFormatZones(workspaceIds: readonly string[]): Map<string, string> {
  const lists = useQueries({
    queries: workspaceIds.map((id) => formatsQueryOptions(id)),
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

/** Every post loaded in any range. */
export function cachedPosts(queryClient: QueryClient): ScheduledPost[] {
  return queryClient
    .getQueriesData<CalendarResponse>({ queryKey: calendarKeys.ranges })
    .flatMap(([, data]) => data?.posts ?? []);
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

export interface CreatePostInput {
  itemId: string;
  channelId: string;
  scheduledAt: string;
}

/** Schedules an approved item into an open slot as a queued post. */
export function useCreatePost() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreatePostInput) => api.request("scheduledPosts.create", { body }),
    onSuccess: (post) => {
      applyPost(queryClient, post);
      void queryClient.invalidateQueries({ queryKey: ["calendar", "approved"] });
    },
  });
}

export interface ScheduleItemInput {
  item: ContentItem;
  /** The version a review approves: the item's current one. */
  versionId: string;
  channels: readonly Channel[];
  scheduledAt: string;
  options?: PostOptions | undefined;
}

/** What scheduling did on one channel: the post, or why it was refused. */
export type ChannelOutcome =
  | { channel: Channel; post: ScheduledPost; error?: undefined }
  | { channel: Channel; post?: undefined; error: unknown };

export interface ScheduleItemResult {
  /** The item after approving it, when it was submitted or in review. */
  approved: ContentItem | null;
  outcomes: ChannelOutcome[];
}

/** States from which `scheduleItem` first sends the item to review (`content.submit`). */
const SUBMIT_FIRST = new Set<ContentItem["state"]>(["render"]);

/**
 * Schedules an item on several channels at one time. An item ready for review (`render`) is
 * submitted first, and one in review approved, so a composed post goes from saved to scheduled in
 * one step. Channels are scheduled one after another; a channel that refuses (`422
 * format_not_supported`, `409 conflict`, a validation error) does not stop the others, and its
 * error comes back with it. A refused submit or approval stops before any post is made.
 */
export async function scheduleItem(
  input: ScheduleItemInput,
  signal?: AbortSignal,
): Promise<ScheduleItemResult> {
  let approved: ContentItem | null = null;
  let state = input.item.state;
  if (SUBMIT_FIRST.has(state)) {
    const submitted = await api.request("content.submit", {
      params: { id: input.item.id },
      body: { versionId: input.versionId },
      signal,
    });
    state = submitted.state;
  }
  if (state === "review") {
    const decided = await api.request("reviews.create", {
      params: { id: input.item.id },
      body: { versionId: input.versionId, decision: "approve" },
      signal,
    });
    approved = decided.item;
  }
  const outcomes: ChannelOutcome[] = [];
  for (const channel of input.channels) {
    try {
      const post = await api.request("scheduledPosts.create", {
        body: {
          itemId: input.item.id,
          channelId: channel.id,
          scheduledAt: input.scheduledAt,
          ...(input.options ? { options: input.options } : {}),
        },
        signal,
      });
      outcomes.push({ channel, post });
    } catch (error) {
      outcomes.push({ channel, error });
    }
  }
  return { approved, outcomes };
}

/** `scheduleItem` with the caches kept current: the item, its review and every new post. */
export function useScheduleItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ScheduleItemInput) => scheduleItem(input),
    onSuccess: ({ approved, outcomes }, input) => {
      if (approved) upsertContentItem(queryClient, approved);
      for (const outcome of outcomes) {
        if (outcome.post) applyPost(queryClient, outcome.post);
      }
      void queryClient.invalidateQueries({ queryKey: contentKeys.detail(input.item.id) });
      void queryClient.invalidateQueries({ queryKey: ["content", "reviews", input.item.id] });
      void queryClient.invalidateQueries({ queryKey: ["calendar", "approved"] });
      if (approved) {
        void queryClient.invalidateQueries({ queryKey: ["approvals"] });
        void queryClient.invalidateQueries({ queryKey: ["reviews", "queue"] });
      }
    },
    // A refused approval may follow a submit that went through: read the item again.
    onError: (_error, input) =>
      void queryClient.invalidateQueries({ queryKey: contentKeys.detail(input.item.id) }),
  });
}
