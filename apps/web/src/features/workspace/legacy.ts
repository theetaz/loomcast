import type { QueryClient } from "@tanstack/react-query";
import type { ParsedLocation } from "@tanstack/react-router";
import { redirect } from "@tanstack/react-router";
import { workspacesQueryOptions } from "@/features/workspaces/queries";
import { pickHomeWorkspace, readLastWorkspace } from "./home";

// Redirects for addresses from before the app was organised by workspace. Loaded with the route
// definitions, so it stays small.

/**
 * Sends an old top-level address, such as `/calendar?view=month`, to the same page in a workspace:
 * `preferred` (an id or slug, such as an old `?workspace=` filter) when it exists, else the
 * remembered or most recent active one. Without any active workspace it goes to `/workspaces`.
 */
export async function redirectIntoWorkspace(
  queryClient: QueryClient,
  location: Pick<ParsedLocation, "searchStr" | "hash">,
  path: string,
  preferred?: string | null,
): Promise<never> {
  const list = await queryClient.ensureQueryData(workspacesQueryOptions());
  const chosen =
    (preferred
      ? list.items.find((workspace) => workspace.id === preferred || workspace.slug === preferred)
      : undefined) ?? pickHomeWorkspace(list.items, readLastWorkspace());
  if (!chosen) throw redirect({ to: "/workspaces", replace: true });
  const hash = location.hash ? `#${location.hash}` : "";
  throw redirect({ href: `/w/${chosen.slug}${path}${location.searchStr}${hash}`, replace: true });
}

/** `/projects/<x>/…` and `/workspaces/<x>/…` became `/w/<x>/…`. */
export function redirectWorkspacePath(
  splat: string | undefined,
  location: Pick<ParsedLocation, "searchStr" | "hash">,
): never {
  if (!splat) throw redirect({ to: "/workspaces", replace: true });
  const hash = location.hash ? `#${location.hash}` : "";
  throw redirect({ href: `/w/${splat}${location.searchStr}${hash}`, replace: true });
}
