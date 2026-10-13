import type {
  Channel,
  CreateChannelRequest,
  List,
  SeriesChannelLink,
  SeriesChannels,
  UpdateChannelRequest,
} from "@loomcast/contracts";
import { type QueryClient, queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, isApiError } from "@/lib/api";
import { useLiveEvent } from "@/lib/live";

/** Channel, series-channel and publisher query keys. The calendar shares the channel list. */
export const channelKeys = {
  all: ["channels"] as const,
  list: ["channels", "list"] as const,
  series: (seriesId: string) => ["series", "channels", seriesId] as const,
  publisher: ["publisher", "status"] as const,
};

export function channelsQueryOptions() {
  return queryOptions({
    queryKey: channelKeys.list,
    queryFn: ({ signal }) => api.request("channels.list", { signal }),
    staleTime: 60_000,
  });
}

/** The server's publishing mode and switch, for the dry-run banner. */
export function publisherStatusQueryOptions() {
  return queryOptions({
    queryKey: channelKeys.publisher,
    queryFn: ({ signal }) => api.request("publisher.status", { signal }),
    staleTime: 30_000,
  });
}

export function seriesChannelsQueryOptions(seriesId: string) {
  return queryOptions({
    queryKey: channelKeys.series(seriesId),
    queryFn: ({ signal }) => api.request("series.channels", { params: { id: seriesId }, signal }),
  });
}

/** Replaces or adds a channel in the cached list. Older copies never replace newer ones. */
export function applyChannel(queryClient: QueryClient, channel: Channel) {
  queryClient.setQueryData<List<Channel>>(channelKeys.list, (list) => {
    if (!list) return list;
    const cached = list.items.find((entry) => entry.id === channel.id);
    if (cached && cached.updatedAt > channel.updatedAt) return list;
    const items = cached
      ? list.items.map((entry) => (entry.id === channel.id ? channel : entry))
      : [...list.items, channel];
    return { items };
  });
}

/** Keeps the channel list current with `channel.updated`, wherever it changed. */
export function useChannelsLive() {
  const queryClient = useQueryClient();
  useLiveEvent("channel.updated", (event) => applyChannel(queryClient, event.payload.channel));
}

export interface UpdateChannelInput {
  channel: Channel;
  change: UpdateChannelRequest;
}

/**
 * Changes a channel's name or switches. The list shows the change at once and puts the channel
 * back when the server refuses it; a `409 dry_run_locked` also refetches the list, since the
 * server's reason is newer than ours. `onFailure` hears about every failed change, including
 * ones made while another was still running.
 */
export function useUpdateChannel(
  options: { onFailure?: (error: Error, input: UpdateChannelInput) => void } = {},
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ channel, change }: UpdateChannelInput) =>
      api.request("channels.update", { params: { id: channel.id }, body: change }),
    onMutate: async ({ channel, change }) => {
      await queryClient.cancelQueries({ queryKey: channelKeys.list });
      queryClient.setQueryData<List<Channel>>(channelKeys.list, (list) =>
        list
          ? {
              items: list.items.map((entry) =>
                entry.id === channel.id ? { ...entry, ...change } : entry,
              ),
            }
          : list,
      );
      return { previous: channel };
    },
    onSuccess: (channel) => applyChannel(queryClient, channel),
    onError: (error, input, context) => {
      if (context) {
        queryClient.setQueryData<List<Channel>>(channelKeys.list, (list) =>
          list
            ? {
                items: list.items.map((entry) =>
                  entry.id === context.previous.id ? context.previous : entry,
                ),
              }
            : list,
        );
      }
      if (isApiError(error, 409) || isApiError(error, 404)) {
        void queryClient.invalidateQueries({ queryKey: channelKeys.list });
      }
      options.onFailure?.(error, input);
    },
  });
}

/** Adds a planning channel: not connected, dry-run on. */
export function useCreateChannel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateChannelRequest) => api.request("channels.create", { body }),
    onSuccess: (channel) => applyChannel(queryClient, channel),
  });
}

/**
 * Sets one channel's link on a series, keeping the others. Unlinked channels are added; switching
 * a linked one off keeps the link (and its posts) but plans nothing new on it. Changes to one
 * series run one at a time, each on top of the last, and show at once.
 */
export function useSetSeriesChannel(seriesId: string) {
  const queryClient = useQueryClient();
  const key = channelKeys.series(seriesId);
  const mutationKey = ["series", "channels", "set", seriesId] as const;
  return useMutation({
    mutationKey,
    scope: { id: `series-channels:${seriesId}` },
    mutationFn: (link: SeriesChannelLink) => {
      const current = queryClient.getQueryData<SeriesChannels>(key);
      return api.request("series.setChannels", {
        params: { id: seriesId },
        body: { channels: withLink(current?.channels ?? [], link) },
      });
    },
    onMutate: async (link) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<SeriesChannels>(key);
      if (previous) {
        queryClient.setQueryData<SeriesChannels>(key, {
          ...previous,
          channels: withLink(previous.channels, link),
        });
      }
      return { previous };
    },
    onSuccess: (data) => {
      // A later change still waiting would flicker back out; its own answer lands next.
      if (queryClient.isMutating({ mutationKey }) <= 1) queryClient.setQueryData(key, data);
    },
    onError: (_error, _link, context) => {
      if (context?.previous) queryClient.setQueryData(key, context.previous);
      void queryClient.invalidateQueries({ queryKey: key });
    },
    onSettled: () => {
      // Replanning moves slots on the calendar.
      void queryClient.invalidateQueries({ queryKey: ["calendar"] });
    },
  });
}

/** `links` with `link` set: replaced in place, or added at the end. */
export function withLink(
  links: readonly SeriesChannelLink[],
  link: SeriesChannelLink,
): SeriesChannelLink[] {
  return links.some((entry) => entry.channelId === link.channelId)
    ? links.map((entry) => (entry.channelId === link.channelId ? link : entry))
    : [...links, link];
}
