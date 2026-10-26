/** Every query key in one place, so live events and mutations patch the same caches. */
export const queryKeys = {
  me: ["auth", "me"] as const,
  workspaces: {
    all: ["workspaces"] as const,
    list: ["workspaces", "list"] as const,
    detail: (idOrSlug: string) => ["workspaces", "detail", idOrSlug] as const,
  },
  conversations: {
    all: ["conversations"] as const,
    list: (workspaceId: string) => ["conversations", "list", workspaceId] as const,
    messages: (conversationId: string) => ["conversations", "messages", conversationId] as const,
  },
  devices: ["devices"] as const,
  tokens: ["tokens"] as const,
  users: ["users"] as const,
  jobs: {
    detail: (id: string) => ["jobs", id] as const,
  },
  analytics: {
    all: ["analytics"] as const,
    overview: (query: { from: string; to: string; workspaceId?: string }) =>
      ["analytics", "overview", query] as const,
    series: (id: string, query: { from?: string; to?: string }) =>
      ["analytics", "series", id, query] as const,
    item: (id: string) => ["analytics", "item", id] as const,
  },
};
