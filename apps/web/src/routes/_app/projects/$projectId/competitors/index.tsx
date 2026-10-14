import { createFileRoute } from "@tanstack/react-router";
import { CompetitorsPage } from "@/features/competitors/CompetitorsPage";
import { ProjectTabBody } from "@/features/project/ProjectLayout";

export const Route = createFileRoute("/_app/projects/$projectId/competitors/")({
  component: CompetitorsTab,
});

function CompetitorsTab() {
  const { projectId } = Route.useParams();
  return (
    <ProjectTabBody idOrSlug={projectId} title="Competitors">
      {(project) => <CompetitorsPage project={project} projectParam={projectId} />}
    </ProjectTabBody>
  );
}
