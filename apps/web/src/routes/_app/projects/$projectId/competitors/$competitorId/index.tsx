import { createFileRoute } from "@tanstack/react-router";
import { CompetitorPage } from "@/features/competitors/CompetitorPage";
import { ProjectTabBody } from "@/features/project/ProjectLayout";

export const Route = createFileRoute("/_app/projects/$projectId/competitors/$competitorId/")({
  component: CompetitorRoute,
});

function CompetitorRoute() {
  const { projectId, competitorId } = Route.useParams();
  return (
    <ProjectTabBody idOrSlug={projectId} title={null}>
      {(project) => (
        <CompetitorPage
          key={competitorId}
          project={project}
          projectParam={projectId}
          competitorId={competitorId}
        />
      )}
    </ProjectTabBody>
  );
}
