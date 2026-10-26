import type {
  ApiChannelAccess,
  ApiClient,
  CreateApiClientRequest,
  List,
  UpdateApiClientRequest,
} from "@loomcast/contracts";
import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";

export const apiClientKeys = {
  list: ["api-clients"] as const,
};

/** Working clients first, then expired and revoked ones; newest first within each. */
export function sortClients(clients: readonly ApiClient[], now = Date.now()): ApiClient[] {
  const rank = (client: ApiClient) => (clientStatus(client, now) === "active" ? 0 : 1);
  return [...clients].sort((a, b) => rank(a) - rank(b) || b.createdAt.localeCompare(a.createdAt));
}

export type ApiClientStatus = "active" | "expired" | "revoked";

export function clientStatus(client: ApiClient, now = Date.now()): ApiClientStatus {
  if (client.revokedAt !== null) return "revoked";
  if (client.expiresAt !== null && Date.parse(client.expiresAt) <= now) return "expired";
  return "active";
}

/**
 * Owner only: the workspace's API clients, revoked ones included. The API lists every workspace's
 * clients in one response, so the cache holds them all and each workspace selects its own.
 */
export function apiClientsQueryOptions(workspaceId: string) {
  return queryOptions({
    queryKey: apiClientKeys.list,
    queryFn: ({ signal }) => api.request("apiClients.list", { signal }),
    select: (list: List<ApiClient>) =>
      sortClients(list.items.filter((client) => client.workspaceId === workspaceId)),
  });
}

function replaceClient(list: List<ApiClient> | undefined, client: ApiClient) {
  return list ? { items: [client, ...list.items.filter((item) => item.id !== client.id)] } : list;
}

/**
 * Creates a client. The response carries its key, so the mutation is never
 * kept once the dialog stops observing it (`gcTime: 0`), and only the key-free
 * client goes into the list cache.
 */
export function useCreateApiClient() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateApiClientRequest) => api.request("apiClients.create", { body }),
    gcTime: 0,
    onSuccess: ({ client }) => {
      queryClient.setQueryData<List<ApiClient>>(apiClientKeys.list, (list) =>
        replaceClient(list, client),
      );
      void queryClient.invalidateQueries({ queryKey: apiClientKeys.list });
    },
  });
}

export function useUpdateApiClient() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateApiClientRequest }) =>
      api.request("apiClients.update", { params: { id }, body }),
    onSuccess: (client) => {
      queryClient.setQueryData<List<ApiClient>>(apiClientKeys.list, (list) =>
        replaceClient(list, client),
      );
      void queryClient.invalidateQueries({ queryKey: apiClientKeys.list });
    },
  });
}

export function useRevokeApiClient() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (client: ApiClient) =>
      api.request("apiClients.revoke", { params: { id: client.id } }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: apiClientKeys.list });
    },
  });
}

export const ACCESS_LABELS: Record<ApiChannelAccess, string> = {
  read: "Read",
  write: "Write",
  publish: "Publish",
};

export const ACCESS_DESCRIPTIONS: Record<ApiChannelAccess | "none", string> = {
  none: "The client can't see this channel.",
  read: "See the channel and its posts' status, links and metrics.",
  write: "Also schedule posts. Each one waits for your approval.",
  publish: "Also approve its own posts. They go out at their time.",
};

/** How long a new client's key works. */
export const EXPIRY_CHOICES = [
  { value: "never", label: "Never expires", days: null },
  { value: "30", label: "30 days", days: 30 },
  { value: "90", label: "90 days", days: 90 },
  { value: "365", label: "1 year", days: 365 },
] as const;
export type ExpiryChoice = (typeof EXPIRY_CHOICES)[number]["value"];

export function expiryFor(choice: ExpiryChoice, now = Date.now()): string | undefined {
  const days = EXPIRY_CHOICES.find((option) => option.value === choice)?.days ?? null;
  return days === null ? undefined : new Date(now + days * 24 * 60 * 60 * 1000).toISOString();
}
