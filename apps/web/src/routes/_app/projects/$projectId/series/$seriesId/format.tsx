import { createFileRoute } from "@tanstack/react-router";
import { FormatPage } from "@/features/formats/FormatPage";
import { ProjectTabBody } from "@/features/project/ProjectLayout";

export const Route = createFileRoute("/_app/projects/$projectId/series/$seriesId/format")({
  staticData: { breadcrumb: "Format" },
  component: FormatRoute,
});

function FormatRoute() {
  const { projectId, seriesId } = Route.useParams();
  return (
    <ProjectTabBody idOrSlug={projectId} title={null}>
      {(project) => (
        <FormatPage key={seriesId} project={project} projectParam={projectId} seriesId={seriesId} />
      )}
    </ProjectTabBody>
  );
}
