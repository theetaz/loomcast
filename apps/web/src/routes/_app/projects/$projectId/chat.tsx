import { createFileRoute } from "@tanstack/react-router";
import { ConversationPanel } from "@/features/conversation/ConversationPanel";
import { ProjectTabBody } from "@/features/project/ProjectLayout";

export const Route = createFileRoute("/_app/projects/$projectId/chat")({
  staticData: { breadcrumb: "Chat" },
  component: ChatTab,
});

function ChatTab() {
  const { projectId } = Route.useParams();
  return (
    <ProjectTabBody idOrSlug={projectId} title="Chat">
      {(project) => <ConversationPanel project={project} />}
    </ProjectTabBody>
  );
}
