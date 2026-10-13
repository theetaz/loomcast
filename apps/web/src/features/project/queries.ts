import type { List, Project, UpdateProject } from "@loomcast/contracts";
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { findCachedProject, projectQueryOptions, sortProjects } from "@/features/projects/queries";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";

/** The project, shown straight away from the list cache when it is there. */
export function useProject(idOrSlug: string) {
  const queryClient = useQueryClient();
  return useQuery({
    ...projectQueryOptions(idOrSlug),
    placeholderData: () =>
      findCachedProject(queryClient.getQueryData<List<Project>>(queryKeys.projects.list), idOrSlug),
  });
}

/** Writes a changed project into the list and both detail keys (id and slug). */
export function cacheProject(queryClient: QueryClient, project: Project) {
  queryClient.setQueryData<List<Project>>(queryKeys.projects.list, (list) =>
    list
      ? { items: sortProjects([project, ...list.items.filter((item) => item.id !== project.id)]) }
      : list,
  );
  queryClient.setQueryData(queryKeys.projects.detail(project.id), project);
  queryClient.setQueryData(queryKeys.projects.detail(project.slug), project);
}

export function useUpdateProject(project: Project) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateProject) =>
      api.request("projects.update", { params: { idOrSlug: project.id }, body }),
    onSuccess: (updated) => cacheProject(queryClient, updated),
  });
}

export function useArchiveProject(project: Project) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.request("projects.archive", { params: { id: project.id } }),
    onSuccess: (archived) => cacheProject(queryClient, archived),
  });
}
