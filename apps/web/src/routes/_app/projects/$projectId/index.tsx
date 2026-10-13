import { createFileRoute, redirect } from "@tanstack/react-router";
import { ProjectTabBody } from "@/features/project/ProjectLayout";
import { ProjectOverview } from "@/features/project/ProjectOverview";

export const Route = createFileRoute("/_app/projects/$projectId/")({
  // Links to a conversation (`?conversation=`) point at the project; they open in the Chat tab.
  beforeLoad: ({ params, search }) => {
    if (search.conversation) {
      throw redirect({
        to: "/projects/$projectId/chat",
        params,
        search: { conversation: search.conversation },
        replace: true,
      });
    }
  },
  component: OverviewTab,
});

function OverviewTab() {
  const { projectId } = Route.useParams();
  return (
    <ProjectTabBody idOrSlug={projectId}>
      {(project) => <ProjectOverview project={project} />}
    </ProjectTabBody>
  );
}
