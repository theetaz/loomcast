import type { Workspace } from "@loomcast/contracts";
import { Badge } from "@loomcast/ui/components/badge";
import { Skeleton } from "@loomcast/ui/components/skeleton";
import { cn } from "@loomcast/ui/lib/cn";
import { Link } from "@tanstack/react-router";
import { RelativeTime } from "@/components/RelativeTime";
import { WorkspaceAvatar } from "@/features/workspace/WorkspaceAvatar";

/** A workspace as a card: icon on its colour, name, description (or slug) and age. */
export function WorkspaceCard({ workspace }: { workspace: Workspace }) {
  return (
    <Link
      to="/w/$workspace"
      params={{ workspace: workspace.slug }}
      className={cn(
        "flex h-full min-w-0 flex-col gap-3 rounded-lg bg-card p-3.5 shadow-card outline-none transition-[background-color,transform] duration-150 ease-out",
        "hover:bg-secondary/60 focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.99]",
        workspace.status === "archived" && "opacity-80",
      )}
    >
      <span className="flex min-w-0 items-center gap-2.5">
        <WorkspaceAvatar workspace={workspace} className="size-8 rounded-[8px] text-[13px]" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-medium text-body text-foreground">{workspace.name}</span>
          <span className="truncate font-mono text-[11px] text-muted-foreground">
            {workspace.slug}
          </span>
        </span>
        {workspace.status === "archived" ? <Badge variant="secondary">Archived</Badge> : null}
      </span>
      <span
        className={cn(
          "line-clamp-2 min-h-[2lh] text-control",
          workspace.description ? "text-text-2" : "text-muted-foreground",
        )}
      >
        {workspace.description ?? "No description yet."}
      </span>
      <span className="mt-auto text-small text-muted-foreground">
        Updated <RelativeTime value={workspace.updatedAt} format="relative" />
      </span>
    </Link>
  );
}

const SKELETON_KEYS = ["a", "b", "c"] as const;

export function WorkspaceCardsSkeleton() {
  return (
    <div aria-hidden="true" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {SKELETON_KEYS.map((key) => (
        <div key={key} className="flex flex-col gap-3 rounded-lg bg-card p-3.5 shadow-card">
          <div className="flex items-center gap-2.5">
            <Skeleton className="size-8 rounded-[8px]" />
            <div className="flex flex-1 flex-col gap-1.5">
              <Skeleton className="h-3 w-32" />
              <Skeleton className="h-2.5 w-20" />
            </div>
          </div>
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-2.5 w-24" />
        </div>
      ))}
    </div>
  );
}
