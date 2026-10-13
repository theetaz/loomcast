import { createFileRoute } from "@tanstack/react-router";
import { ProjectTabBody } from "@/features/project/ProjectLayout";
import { SeriesList } from "@/features/series/SeriesList";

export const Route = createFileRoute("/_app/projects/$projectId/series/")({
  component: SeriesTab,
});

function SeriesTab() {
  const { projectId } = Route.useParams();
  return (
    <ProjectTabBody idOrSlug={projectId} title="Series">
      {(project) => <SeriesList project={project} projectParam={projectId} />}
    </ProjectTabBody>
  );
}
