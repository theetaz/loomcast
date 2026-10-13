import { createFileRoute } from "@tanstack/react-router";
import { ProjectTabBody } from "@/features/project/ProjectLayout";
import { SeriesDetail } from "@/features/series/SeriesDetail";

export const Route = createFileRoute("/_app/projects/$projectId/series/$seriesId/")({
  component: SeriesRoute,
});

function SeriesRoute() {
  const { projectId, seriesId } = Route.useParams();
  return (
    <ProjectTabBody idOrSlug={projectId} title={null}>
      {(project) => (
        <SeriesDetail
          key={seriesId}
          project={project}
          projectParam={projectId}
          seriesId={seriesId}
        />
      )}
    </ProjectTabBody>
  );
}
