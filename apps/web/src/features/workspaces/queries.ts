import type { CreateWorkspace, List, Workspace } from "@loomcast/contracts";
import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";

/** Most recently updated first. */
export function sortWorkspaces(workspaces: readonly Workspace[]): Workspace[] {
  return [...workspaces].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function workspacesQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.workspaces.list,
    queryFn: ({ signal }) => api.request("workspaces.list", { signal }),
    select: (list: List<Workspace>) => sortWorkspaces(list.items),
  });
}

export function workspaceQueryOptions(idOrSlug: string) {
  return queryOptions({
    queryKey: queryKeys.workspaces.detail(idOrSlug),
    queryFn: ({ signal }) => api.request("workspaces.get", { params: { idOrSlug }, signal }),
  });
}

/** The cached list entry for a workspace, so its page renders before the request returns. */
export function findCachedWorkspace(
  list: List<Workspace> | undefined,
  idOrSlug: string,
): Workspace | undefined {
  return list?.items.find((workspace) => workspace.id === idOrSlug || workspace.slug === idOrSlug);
}

export function useCreateWorkspace() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateWorkspace) => api.request("workspaces.create", { body }),
    onSuccess: (workspace) => {
      queryClient.setQueryData<List<Workspace>>(queryKeys.workspaces.list, (list) =>
        list
          ? { items: [workspace, ...list.items.filter((item) => item.id !== workspace.id)] }
          : list,
      );
      queryClient.setQueryData(queryKeys.workspaces.detail(workspace.id), workspace);
      void queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.list });
    },
  });
}
