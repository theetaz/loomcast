import type { CreateProject, List, Project } from "@loomcast/contracts";
import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";

/** Most recently updated first. */
export function sortProjects(projects: readonly Project[]): Project[] {
  return [...projects].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function projectsQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.projects.list,
    queryFn: ({ signal }) => api.request("projects.list", { signal }),
    select: (list: List<Project>) => sortProjects(list.items),
  });
}

export function projectQueryOptions(idOrSlug: string) {
  return queryOptions({
    queryKey: queryKeys.projects.detail(idOrSlug),
    queryFn: ({ signal }) => api.request("projects.get", { params: { idOrSlug }, signal }),
  });
}

/** The cached list entry for a project, so its page renders before the request returns. */
export function findCachedProject(
  list: List<Project> | undefined,
  idOrSlug: string,
): Project | undefined {
  return list?.items.find((project) => project.id === idOrSlug || project.slug === idOrSlug);
}

export function useCreateProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateProject) => api.request("projects.create", { body }),
    onSuccess: (project) => {
      queryClient.setQueryData<List<Project>>(queryKeys.projects.list, (list) =>
        list ? { items: [project, ...list.items.filter((item) => item.id !== project.id)] } : list,
      );
      queryClient.setQueryData(queryKeys.projects.detail(project.id), project);
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects.list });
    },
  });
}
