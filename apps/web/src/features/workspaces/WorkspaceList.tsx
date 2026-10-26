import type { Workspace } from "@loomcast/contracts";
import { Button } from "@loomcast/ui/components/button";
import { Label } from "@loomcast/ui/components/label";
import { Switch } from "@loomcast/ui/components/switch";
import { useQuery } from "@tanstack/react-query";
import { ArchiveIcon, FolderIcon, PlusIcon } from "lucide-react";
import { useId } from "react";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { NewWorkspaceDialog } from "./NewWorkspaceDialog";
import { workspacesQueryOptions } from "./queries";
import { WorkspaceCard, WorkspaceCardsSkeleton } from "./WorkspaceCard";

export interface WorkspaceListProps {
  showArchived: boolean;
  onShowArchivedChange: (show: boolean) => void;
}

/** Every workspace as a card, most recently updated first; archived ones behind a switch. */
export function WorkspaceList({ showArchived, onShowArchivedChange }: WorkspaceListProps) {
  const id = useId();
  const query = useQuery(workspacesQueryOptions());

  if (query.isPending) return <WorkspaceCardsSkeleton />;

  if (query.isError) {
    return (
      <ErrorState
        title="Couldn't load workspaces"
        error={query.error}
        onRetry={() => void query.refetch()}
        retrying={query.isFetching}
      />
    );
  }

  if (query.data.length === 0) {
    return (
      <EmptyState
        icon={FolderIcon}
        title="No workspaces yet"
        description="Start one for each brand or series. Its channels, calendar, library and research live inside it."
        action={
          <NewWorkspaceDialog>
            <Button>
              <PlusIcon aria-hidden="true" />
              New workspace
            </Button>
          </NewWorkspaceDialog>
        }
      />
    );
  }

  const active = query.data.filter((workspace) => workspace.status === "active");
  const archived = query.data.filter((workspace) => workspace.status === "archived");

  return (
    <div className="flex flex-col gap-5">
      {active.length === 0 ? (
        <EmptyState
          size="compact"
          icon={FolderIcon}
          title="No active workspaces"
          description="Every workspace is archived. Create a new one to get going again."
        />
      ) : (
        <Cards label="Active workspaces" workspaces={active} />
      )}

      {archived.length > 0 ? (
        <div className="flex items-center gap-2.5">
          <Switch
            id={`${id}-archived`}
            checked={showArchived}
            onCheckedChange={onShowArchivedChange}
          />
          <Label htmlFor={`${id}-archived`} className="font-normal text-control">
            Show archived
            <span className="font-mono text-[10.5px] text-muted-foreground tabular-nums">
              {archived.length}
            </span>
          </Label>
        </div>
      ) : null}

      {showArchived && archived.length > 0 ? (
        <section aria-labelledby={`${id}-archived-title`} className="flex flex-col gap-3">
          <h2
            id={`${id}-archived-title`}
            className="flex items-center gap-1.5 font-semibold text-[13px] text-muted-foreground"
          >
            <ArchiveIcon aria-hidden="true" className="size-3.5" />
            Archived
          </h2>
          <Cards label="Archived workspaces" workspaces={archived} />
        </section>
      ) : null}
    </div>
  );
}

function Cards({ label, workspaces }: { label: string; workspaces: Workspace[] }) {
  return (
    <ul aria-label={label} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {workspaces.map((workspace) => (
        <li key={workspace.id} className="min-w-0">
          <WorkspaceCard workspace={workspace} />
        </li>
      ))}
    </ul>
  );
}
