import { Skeleton } from "@loomcast/ui/components/skeleton";
import { useWorkspace } from "./queries";
import { WorkspaceAvatar } from "./WorkspaceAvatar";

// Its own module: route breadcrumbs load with the app, so they must not pull in the workspace page.
export function WorkspaceCrumb({ idOrSlug }: { idOrSlug: string }) {
  const query = useWorkspace(idOrSlug);
  if (query.data) {
    return (
      <span className="inline-flex min-w-0 items-center gap-1.5 align-middle">
        <WorkspaceAvatar workspace={query.data} className="size-4 rounded-[4px] text-[9px]" />
        <span className="truncate">{query.data.name}</span>
      </span>
    );
  }
  if (query.isPending)
    return <Skeleton aria-hidden="true" className="inline-block h-3 w-28 align-middle" />;
  return <>Workspace</>;
}
