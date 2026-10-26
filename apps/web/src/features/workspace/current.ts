import type { Workspace } from "@loomcast/contracts";
import { useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { workspacesQueryOptions } from "@/features/workspaces/queries";
import { pickHomeWorkspace } from "./home";
import { useWorkspace } from "./queries";

/** The `$workspace` route parameter (a slug, or an id until the layout swaps it), outside `/w/` null. */
export function useOptionalWorkspaceParam(): string | null {
  const params: { workspace?: string } = useParams({ strict: false });
  return params.workspace ?? null;
}

/** The `$workspace` route parameter, for links inside the open workspace. Only under `/w/`. */
export function useWorkspaceParam(): string {
  const param = useOptionalWorkspaceParam();
  if (param === null) throw new Error("useWorkspaceParam is only available inside a workspace");
  return param;
}

/**
 * The open workspace. Only under `/w/$workspace`: the layout renders its pages once the workspace
 * has loaded, so this reads it from the cache.
 */
export function useCurrentWorkspace(): Workspace {
  const param = useWorkspaceParam();
  const { data } = useWorkspace(param);
  if (!data) throw new Error("The workspace has not loaded yet");
  return data;
}

/** The open workspace under `/w/`, once loaded; null anywhere else. */
export function useOptionalCurrentWorkspace(): Workspace | null {
  const param = useOptionalWorkspaceParam();
  const { data } = useWorkspace(param ?? "", { enabled: param !== null });
  return param === null ? null : (data ?? null);
}

/**
 * The workspace the shell works in: the open one, else the one the app would open (the remembered
 * or most recent active workspace). Null while loading, or when there is none.
 */
export function useShellWorkspace(): Workspace | null {
  const param = useOptionalWorkspaceParam();
  const current = useWorkspace(param ?? "", { enabled: param !== null });
  const list = useQuery({ ...workspacesQueryOptions(), enabled: param === null });
  if (param !== null) return current.data ?? null;
  return list.data ? pickHomeWorkspace(list.data) : null;
}
