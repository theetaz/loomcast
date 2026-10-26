import { IdSchema } from "@loomcast/contracts";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { ScanPage } from "@/features/competitors/ScanPage";
import { WorkspacePage } from "@/features/workspace/WorkspaceLayout";

export const Route = createFileRoute("/_app/w/$workspace/competitors/$competitorId/scans/$scanId")({
  beforeLoad: ({ params }) => {
    if (!IdSchema.safeParse(params.scanId).success) throw notFound();
  },
  staticData: { breadcrumb: "Scan" },
  component: ScanRoute,
});

function ScanRoute() {
  const { workspace: workspaceParam, competitorId, scanId } = Route.useParams();
  return (
    <WorkspacePage title={null}>
      {(workspace) => (
        <ScanPage
          key={scanId}
          workspace={workspace}
          workspaceParam={workspaceParam}
          competitorId={competitorId}
          scanId={scanId}
        />
      )}
    </WorkspacePage>
  );
}
