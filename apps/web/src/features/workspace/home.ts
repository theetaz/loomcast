import type { List, Workspace } from "@loomcast/contracts";
import type { QueryClient } from "@tanstack/react-query";
import { workspacesQueryOptions } from "@/features/workspaces/queries";

// Loaded with the route definitions (not split): the redirects into a workspace use it.

/** Where the last workspace opened is kept, per browser, as its id. */
export const LAST_WORKSPACE_KEY = "loomcast.workspace.last";

export function readLastWorkspace(): string | null {
  try {
    return window.localStorage.getItem(LAST_WORKSPACE_KEY);
  } catch {
    return null;
  }
}

export function rememberWorkspace(id: string) {
  try {
    window.localStorage.setItem(LAST_WORKSPACE_KEY, id);
  } catch {
    // Storage can be full or blocked; the app then opens the most recent workspace.
  }
}

/**
 * The workspace the app opens in: the remembered one while it exists and is active, else the most
 * recently updated active one. Null when there is no active workspace.
 */
export function pickHomeWorkspace(
  workspaces: readonly Workspace[],
  remembered: string | null = readLastWorkspace(),
): Workspace | null {
  const active = workspaces.filter((workspace) => workspace.status === "active");
  const last = remembered
    ? active.find((workspace) => workspace.id === remembered || workspace.slug === remembered)
    : undefined;
  if (last) return last;
  return [...active].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null;
}

/** Loads the workspaces (from the cache when it has them) and picks the one to open. */
export async function resolveHomeWorkspace(queryClient: QueryClient): Promise<Workspace | null> {
  const list: List<Workspace> = await queryClient.ensureQueryData(workspacesQueryOptions());
  return pickHomeWorkspace(list.items);
}
