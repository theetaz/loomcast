import { createFileRoute } from "@tanstack/react-router";
import { CompetitorPage } from "@/features/competitors/CompetitorPage";
import { WorkspacePage } from "@/features/workspace/WorkspaceLayout";

export const Route = createFileRoute("/_app/w/$workspace/competitors/$competitorId/")({
  component: CompetitorRoute,
});

function CompetitorRoute() {
  const { workspace: workspaceParam, competitorId } = Route.useParams();
  return (
    <WorkspacePage title={null}>
      {(workspace) => (
        <CompetitorPage
          key={competitorId}
          workspace={workspace}
          workspaceParam={workspaceParam}
          competitorId={competitorId}
        />
      )}
    </WorkspacePage>
  );
}
