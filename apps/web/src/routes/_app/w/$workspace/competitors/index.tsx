import { createFileRoute } from "@tanstack/react-router";
import { CompetitorsPage } from "@/features/competitors/CompetitorsPage";
import { WorkspacePage } from "@/features/workspace/WorkspaceLayout";

export const Route = createFileRoute("/_app/w/$workspace/competitors/")({
  component: CompetitorsTab,
});

function CompetitorsTab() {
  const { workspace: workspaceParam } = Route.useParams();
  return (
    <WorkspacePage title="Competitors">
      {(workspace) => <CompetitorsPage workspace={workspace} workspaceParam={workspaceParam} />}
    </WorkspacePage>
  );
}
