import { IdSchema } from "@loomcast/contracts";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { ScanPage } from "@/features/competitors/ScanPage";
import { ProjectTabBody } from "@/features/project/ProjectLayout";

export const Route = createFileRoute(
  "/_app/projects/$projectId/competitors/$competitorId/scans/$scanId",
)({
  beforeLoad: ({ params }) => {
    if (!IdSchema.safeParse(params.scanId).success) throw notFound();
  },
  staticData: { breadcrumb: "Scan" },
  component: ScanRoute,
});

function ScanRoute() {
  const { projectId, competitorId, scanId } = Route.useParams();
  return (
    <ProjectTabBody idOrSlug={projectId} title={null}>
      {(project) => (
        <ScanPage
          key={scanId}
          project={project}
          projectParam={projectId}
          competitorId={competitorId}
          scanId={scanId}
        />
      )}
    </ProjectTabBody>
  );
}
