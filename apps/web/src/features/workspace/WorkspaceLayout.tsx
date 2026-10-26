import type { Workspace } from "@loomcast/contracts";
import { Button } from "@loomcast/ui/components/button";
import { Skeleton } from "@loomcast/ui/components/skeleton";
import { Link, Outlet, useLocation, useRouter } from "@tanstack/react-router";
import { FolderXIcon } from "lucide-react";
import { type ReactNode, useEffect } from "react";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { Page } from "@/components/PageHeader";
import { useKbLive } from "@/features/kb/use-kb-live";
import { isApiError } from "@/lib/api";
import { useTitle } from "@/lib/use-title";
import { useCurrentWorkspace } from "./current";
import { rememberWorkspace } from "./home";
import { useWorkspace } from "./queries";

/**
 * Everything under `/w/$workspace`. `param` is the workspace's slug or id; an id is swapped for the
 * slug in the address. Loading, not-found and error states cover the whole page, so the pages below
 * only render once the workspace is known, and read it with `useCurrentWorkspace`. The workspace is
 * remembered as the one the app opens next time. Knowledge-base live events are applied here, so
 * every page sees the same entries.
 */
export function WorkspaceLayout({ param }: { param: string }) {
  const query = useWorkspace(param);
  const workspace = query.data;
  useKbLive();
  useCanonicalAddress(param, workspace);

  useEffect(() => {
    if (workspace) rememberWorkspace(workspace.id);
  }, [workspace]);

  if (query.isPending) {
    return (
      <Page className="flex-1">
        <WorkspaceTitle page="Workspace" />
        <div aria-hidden="true" className="flex items-start gap-3">
          <Skeleton className="mt-1 size-6 rounded-md" />
          <div className="flex flex-1 flex-col gap-2 pt-1">
            <Skeleton className="h-5 w-56 max-w-full" />
            <Skeleton className="h-3 w-40" />
          </div>
        </div>
        <Skeleton aria-hidden="true" className="min-h-[320px] flex-1 rounded-lg" />
      </Page>
    );
  }

  if (query.isError) {
    if (isApiError(query.error, 404)) {
      return (
        <Page className="flex-1 justify-center">
          <WorkspaceTitle page="Workspace not found" />
          <h1 className="sr-only">Workspace not found</h1>
          <EmptyState
            icon={FolderXIcon}
            title="Workspace not found"
            description="It may have been removed, or the link points somewhere else."
            action={
              <Button asChild variant="outline">
                <Link to="/workspaces">All workspaces</Link>
              </Button>
            }
          />
        </Page>
      );
    }
    return (
      <Page className="flex-1 justify-center">
        <WorkspaceTitle page="Workspace" />
        <ErrorState
          title="Couldn't load this workspace"
          error={query.error}
          onRetry={() => void query.refetch()}
          retrying={query.isFetching}
        />
      </Page>
    );
  }

  return <Outlet />;
}

/** Swaps an id in the address for the workspace's slug, keeping the rest of the address. */
function useCanonicalAddress(param: string, workspace: Workspace | undefined) {
  const router = useRouter();
  const location = useLocation();
  const slug = workspace?.slug;
  useEffect(() => {
    if (!slug || slug === param) return;
    const prefix = `/w/${param}`;
    if (location.pathname !== prefix && !location.pathname.startsWith(`${prefix}/`)) return;
    const rest = location.pathname.slice(prefix.length);
    const hash = location.hash ? `#${location.hash}` : "";
    void router.navigate({
      href: `/w/${slug}${rest}${location.searchStr}${hash}`,
      replace: true,
    });
  }, [router, location.pathname, location.searchStr, location.hash, param, slug]);
}

function WorkspaceTitle({ page }: { page: string }) {
  useTitle(page);
  return null;
}

/**
 * A page of the open workspace in the usual content column. It sets the document title to
 * `<title> · <workspace>`; pages that name themselves (an entry, say) pass `title={null}` and set
 * it with `useTitle`.
 */
export function WorkspacePage({
  title,
  className,
  children,
}: {
  title?: string | null;
  className?: string;
  children: (workspace: Workspace) => ReactNode;
}) {
  const workspace = useCurrentWorkspace();
  return (
    <Page className={className}>
      {title === null ? null : (
        <WorkspaceTitle page={title ? `${title} · ${workspace.name}` : workspace.name} />
      )}
      {children(workspace)}
    </Page>
  );
}

/** Sets the document title of a workspace page that lays itself out. */
export function useWorkspaceTitle(title: string) {
  const workspace = useCurrentWorkspace();
  useTitle(`${title} · ${workspace.name}`);
}
