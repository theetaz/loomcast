import type { AcceptConnectionResponse } from "@loomcast/contracts";
import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { applyChannel, channelKeys } from "../queries";

export const connectKeys = {
  features: ["system", "features"] as const,
  connection: (id: string) => ["oauth", "connection", id] as const,
};

/** The server's feature flags, such as whether X can be connected. */
export function systemFeaturesQueryOptions() {
  return queryOptions({
    queryKey: connectKeys.features,
    queryFn: ({ signal }) => api.request("system.features", { signal }),
    staleTime: 5 * 60_000,
  });
}

/** Whether X publishing is on. Off while the flags load or when they fail to. */
export function useXPublishing(): boolean {
  const { data } = useQuery(systemFeaturesQueryOptions());
  return data?.xPublishing === true;
}

/**
 * The accounts of a pending connection. It is read once: a refetch could only find it expired, and
 * the page already says when it runs out.
 */
export function connectionQueryOptions(id: string) {
  return queryOptions({
    queryKey: connectKeys.connection(id),
    queryFn: ({ signal }) => api.request("oauth.connection", { params: { id }, signal }),
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
    retry: false,
  });
}

export interface AcceptConnectionInput {
  workspaceId: string;
  accountIds: string[];
}

/** Connects the chosen accounts of a pending connection to a workspace, once. */
export function useAcceptConnection(connectionId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: AcceptConnectionInput) =>
      api.request("oauth.accept", { params: { id: connectionId }, body }),
    onSuccess: (result: AcceptConnectionResponse) => {
      for (const channel of result.channels) applyChannel(queryClient, channel);
      void queryClient.invalidateQueries({ queryKey: channelKeys.lists });
      queryClient.removeQueries({ queryKey: connectKeys.connection(connectionId) });
    },
  });
}
