import type { List, SetWorkspaceIcon, UpdateWorkspace, Workspace } from "@loomcast/contracts";
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  findCachedWorkspace,
  sortWorkspaces,
  workspaceQueryOptions,
} from "@/features/workspaces/queries";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";

/** The workspace, shown straight away from the list cache when it is there. */
export function useWorkspace(idOrSlug: string, options: { enabled?: boolean } = {}) {
  const queryClient = useQueryClient();
  return useQuery({
    ...workspaceQueryOptions(idOrSlug),
    enabled: options.enabled ?? true,
    placeholderData: () =>
      findCachedWorkspace(
        queryClient.getQueryData<List<Workspace>>(queryKeys.workspaces.list),
        idOrSlug,
      ),
  });
}

/** Writes a changed workspace into the list and both detail keys (id and slug). */
export function cacheWorkspace(queryClient: QueryClient, workspace: Workspace) {
  queryClient.setQueryData<List<Workspace>>(queryKeys.workspaces.list, (list) =>
    list
      ? {
          items: sortWorkspaces([
            workspace,
            ...list.items.filter((item) => item.id !== workspace.id),
          ]),
        }
      : list,
  );
  queryClient.setQueryData(queryKeys.workspaces.detail(workspace.id), workspace);
  queryClient.setQueryData(queryKeys.workspaces.detail(workspace.slug), workspace);
}

export function useUpdateWorkspace(workspace: Workspace) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateWorkspace) =>
      api.request("workspaces.update", { params: { idOrSlug: workspace.id }, body }),
    onSuccess: (updated) => cacheWorkspace(queryClient, updated),
  });
}

export function useArchiveWorkspace(workspace: Workspace) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.request("workspaces.archive", { params: { id: workspace.id } }),
    onSuccess: (archived) => cacheWorkspace(queryClient, archived),
  });
}

/** Sets the icon from an uploaded image (`{mime, data}`) or a channel's picture (`{fromChannelId}`). */
export function useSetWorkspaceIcon(workspace: Workspace) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: SetWorkspaceIcon) =>
      api.request("workspaces.setIcon", { params: { id: workspace.id }, body }),
    onSuccess: (updated) => cacheWorkspace(queryClient, updated),
  });
}

export function useClearWorkspaceIcon(workspace: Workspace) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.request("workspaces.clearIcon", { params: { id: workspace.id } }),
    onSuccess: (updated) => cacheWorkspace(queryClient, updated),
  });
}
