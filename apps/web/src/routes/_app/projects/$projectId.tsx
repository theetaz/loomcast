import { IdSchema } from "@loomcast/contracts";
import { createFileRoute } from "@tanstack/react-router";
import { ProjectCrumb, ProjectPage } from "@/features/projects/ProjectPage";

/** `?conversation=<id>` opens that conversation in the panel; anything else is dropped. */
interface ProjectSearch {
  conversation?: string;
}

export const Route = createFileRoute("/_app/projects/$projectId")({
  validateSearch: (search: Record<string, unknown>): ProjectSearch => {
    const conversation = IdSchema.safeParse(search.conversation);
    return conversation.success ? { conversation: conversation.data } : {};
  },
  staticData: { breadcrumb: (params) => <ProjectCrumb idOrSlug={params.projectId ?? ""} /> },
  component: ProjectRoute,
});

function ProjectRoute() {
  const { projectId } = Route.useParams();
  return <ProjectPage idOrSlug={projectId} />;
}
