import { createFileRoute } from "@tanstack/react-router";
import { SeriesDetail } from "@/features/series/SeriesDetail";
import { WorkspacePage } from "@/features/workspace/WorkspaceLayout";

export const Route = createFileRoute("/_app/w/$workspace/series/$seriesId/")({
  component: SeriesRoute,
});

function SeriesRoute() {
  const { workspace: workspaceParam, seriesId } = Route.useParams();
  return (
    <WorkspacePage title={null}>
      {(workspace) => (
        <SeriesDetail
          key={seriesId}
          workspace={workspace}
          workspaceParam={workspaceParam}
          seriesId={seriesId}
        />
      )}
    </WorkspacePage>
  );
}
