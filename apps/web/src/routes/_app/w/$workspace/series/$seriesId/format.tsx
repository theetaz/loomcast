import { createFileRoute } from "@tanstack/react-router";
import { FormatPage } from "@/features/formats/FormatPage";
import { WorkspacePage } from "@/features/workspace/WorkspaceLayout";

export const Route = createFileRoute("/_app/w/$workspace/series/$seriesId/format")({
  staticData: { breadcrumb: "Format" },
  component: FormatRoute,
});

function FormatRoute() {
  const { workspace: workspaceParam, seriesId } = Route.useParams();
  return (
    <WorkspacePage title={null}>
      {(workspace) => (
        <FormatPage
          key={seriesId}
          workspace={workspace}
          workspaceParam={workspaceParam}
          seriesId={seriesId}
        />
      )}
    </WorkspacePage>
  );
}
