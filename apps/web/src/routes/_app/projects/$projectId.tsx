import { createFileRoute } from "@tanstack/react-router";
import { ProjectCrumb, ProjectPage } from "@/features/projects/ProjectPage";

export const Route = createFileRoute("/_app/projects/$projectId")({
  staticData: { breadcrumb: (params) => <ProjectCrumb idOrSlug={params.projectId ?? ""} /> },
  component: ProjectRoute,
});

function ProjectRoute() {
  const { projectId } = Route.useParams();
  return <ProjectPage idOrSlug={projectId} />;
}
