import type {
  AccessToken,
  CreateTokenRequest,
  Device,
  List,
  McpTokenScope,
  TokenScope,
} from "@loomcast/contracts";
import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";

/** MCP tokens that still work, newest first. Device tokens are managed with their device. */
export function tokensQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.tokens,
    queryFn: ({ signal }) => api.request("tokens.list", { signal }),
    select: (list: List<AccessToken>) =>
      list.items
        .filter((token) => token.kind === "mcp" && token.revokedAt === null)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  });
}

/**
 * A single-use pairing code. Kept out of every cache: the dialog holds it in
 * state and the mutation is dropped as soon as nothing observes it.
 */
export function useCreatePairingCode() {
  return useMutation({
    mutationFn: () => api.request("devices.createPairingCode"),
    gcTime: 0,
  });
}

export function useRevokeDevice() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (device: Device) => api.request("devices.revoke", { params: { id: device.id } }),
    onSuccess: (_, device) => {
      queryClient.setQueryData<List<Device>>(queryKeys.devices, (list) =>
        list ? { items: list.items.filter((item) => item.id !== device.id) } : list,
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.devices });
    },
  });
}

/**
 * Creates an MCP token. The response carries the secret, so the mutation is
 * never kept once the dialog stops observing it (`gcTime: 0`), and only the
 * secret-free token goes into the list cache.
 */
export function useCreateToken() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateTokenRequest) => api.request("tokens.create", { body }),
    gcTime: 0,
    onSuccess: ({ token }) => {
      queryClient.setQueryData<List<AccessToken>>(queryKeys.tokens, (list) =>
        list ? { items: [token, ...list.items.filter((item) => item.id !== token.id)] } : list,
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.tokens });
    },
  });
}

export function useRevokeToken() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (token: AccessToken) => api.request("tokens.revoke", { params: { id: token.id } }),
    onSuccess: (_, token) => {
      queryClient.setQueryData<List<AccessToken>>(queryKeys.tokens, (list) =>
        list ? { items: list.items.filter((item) => item.id !== token.id) } : list,
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.tokens });
    },
  });
}

export const SCOPE_LABELS: Record<TokenScope, string> = {
  "mcp:read": "Read",
  "mcp:write": "Write",
  "mcp:admin": "Admin",
  bridge: "Studio agent",
};

export const SCOPE_DESCRIPTIONS: Record<McpTokenScope, string> = {
  "mcp:read": "List workspaces and read their details.",
  "mcp:write": "Create workspaces and change them.",
  "mcp:admin": "Everything the owner can do. Only the owner can grant it.",
};
