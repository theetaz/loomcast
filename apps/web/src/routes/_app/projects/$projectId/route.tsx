import { IdSchema } from "@loomcast/contracts";
import { createFileRoute } from "@tanstack/react-router";
import { ProjectCrumb, ProjectLayout } from "@/features/project/ProjectLayout";

/**
 * `?conversation=<id>` opens that conversation in the Chat tab; anything else is dropped. It is
 * declared here, on the layout, because the conversation panel reads it from this route.
 */
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
  return <ProjectLayout idOrSlug={projectId} />;
}
