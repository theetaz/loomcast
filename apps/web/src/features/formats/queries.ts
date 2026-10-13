import type { Format, FormatRules, List, SkillSummary } from "@loomcast/contracts";
import { type QueryClient, queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";

/** Format query keys. A saved version updates the detail, the project list and the history. */
export const formatKeys = {
  all: ["formats"] as const,
  list: (projectId: string) => ["formats", "list", projectId] as const,
  detail: (id: string) => ["formats", "detail", id] as const,
  versions: (id: string) => ["formats", "versions", id] as const,
};

export function formatsListQueryOptions(projectId: string) {
  return queryOptions({
    queryKey: formatKeys.list(projectId),
    queryFn: ({ signal }) => api.request("formats.list", { params: { projectId }, signal }),
    staleTime: 60_000,
  });
}

export function formatQueryOptions(id: string) {
  return queryOptions({
    queryKey: formatKeys.detail(id),
    queryFn: ({ signal }) => api.request("formats.get", { params: { id }, signal }),
  });
}

/** Every version of a format, newest first. */
export function formatVersionsQueryOptions(id: string) {
  return queryOptions({
    queryKey: formatKeys.versions(id),
    queryFn: ({ signal }) => api.request("formats.versions", { params: { id }, signal }),
  });
}

/** Recipe skills, for the recipe picker and its hints. Skills change rarely. */
export function recipesQueryOptions() {
  return queryOptions({
    queryKey: ["skills", "list"] as const,
    queryFn: ({ signal }) => api.request("skills.list", { signal }),
    staleTime: 5 * 60_000,
    select: (list: List<SkillSummary>) => list.items.filter((skill) => skill.kind === "recipe"),
  });
}

/** Puts a format into its detail cache and the project's list. */
export function cacheFormat(queryClient: QueryClient, format: Format) {
  queryClient.setQueryData(formatKeys.detail(format.id), format);
  queryClient.setQueryData<List<Format>>(formatKeys.list(format.projectId), (list) => {
    if (!list) return list;
    const exists = list.items.some((entry) => entry.id === format.id);
    return {
      items: exists
        ? list.items.map((entry) => (entry.id === format.id ? format : entry))
        : [...list.items, format].sort((a, b) => a.name.localeCompare(b.name)),
    };
  });
}

export interface UpdateFormatInput {
  format: Format;
  /** The version the edit started from; a newer current version answers 409. */
  baseVersionId: string;
  name?: string;
  rules?: FormatRules;
}

/** Saves a new version of a format. */
export function useUpdateFormat() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ format, baseVersionId, name, rules }: UpdateFormatInput) =>
      api.request("formats.update", {
        params: { id: format.id },
        body: {
          baseVersionId,
          ...(name !== undefined ? { name } : {}),
          ...(rules !== undefined ? { rules } : {}),
        },
      }),
    onSuccess: (format) => {
      cacheFormat(queryClient, format);
      void queryClient.invalidateQueries({ queryKey: formatKeys.versions(format.id) });
    },
  });
}

/** Creates a format; without rules it starts from the defaults. */
export function useCreateFormat() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, name }: { projectId: string; name: string }) =>
      api.request("formats.create", { params: { projectId }, body: { name } }),
    onSuccess: (format) => cacheFormat(queryClient, format),
  });
}
