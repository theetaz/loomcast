import { Button } from "@loomcast/ui/components/button";
import { createFileRoute } from "@tanstack/react-router";
import { PlusIcon } from "lucide-react";
import { z } from "zod";
import { Page, PageHeader } from "@/components/PageHeader";
import { NewWorkspaceDialog } from "@/features/workspaces/NewWorkspaceDialog";
import { WorkspaceList } from "@/features/workspaces/WorkspaceList";
import { useTitle } from "@/lib/use-title";

/** `?archived=true` shows the archived workspaces too. */
const workspacesSearchSchema = z.object({
  archived: z.boolean().optional().catch(undefined),
});

export const Route = createFileRoute("/_app/workspaces/")({
  validateSearch: workspacesSearchSchema,
  component: WorkspacesPage,
});

function WorkspacesPage() {
  useTitle("Workspaces");
  const { archived = false } = Route.useSearch();
  const navigate = Route.useNavigate();

  return (
    <Page>
      <PageHeader
        title="Workspaces"
        description="Each workspace has its own channels, calendar, library and research. Everyone signed in sees every workspace."
        actions={
          <NewWorkspaceDialog>
            <Button>
              <PlusIcon aria-hidden="true" />
              New workspace
            </Button>
          </NewWorkspaceDialog>
        }
      />
      <WorkspaceList
        showArchived={archived}
        onShowArchivedChange={(show) =>
          void navigate({ search: show ? { archived: true } : {}, replace: true })
        }
      />
    </Page>
  );
}
