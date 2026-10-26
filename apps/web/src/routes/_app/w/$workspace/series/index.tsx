import { createFileRoute } from "@tanstack/react-router";
import { SeriesList } from "@/features/series/SeriesList";
import { WorkspacePage } from "@/features/workspace/WorkspaceLayout";

export const Route = createFileRoute("/_app/w/$workspace/series/")({
  component: SeriesTab,
});

function SeriesTab() {
  const { workspace: workspaceParam } = Route.useParams();
  return (
    <WorkspacePage title="Series">
      {(workspace) => <SeriesList workspace={workspace} workspaceParam={workspaceParam} />}
    </WorkspacePage>
  );
}
