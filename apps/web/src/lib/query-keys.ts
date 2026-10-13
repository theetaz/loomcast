/** Every query key in one place, so live events and mutations patch the same caches. */
export const queryKeys = {
  me: ["auth", "me"] as const,
  projects: {
    all: ["projects"] as const,
    list: ["projects", "list"] as const,
    detail: (idOrSlug: string) => ["projects", "detail", idOrSlug] as const,
  },
  devices: ["devices"] as const,
  tokens: ["tokens"] as const,
  jobs: {
    detail: (id: string) => ["jobs", id] as const,
  },
};
