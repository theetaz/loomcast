import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/PageHeader";
import { ConversationPanel } from "@/features/conversation/ConversationPanel";
import { WorkspacePage } from "@/features/workspace/WorkspaceLayout";

export const Route = createFileRoute("/_app/w/$workspace/chat")({
  staticData: { breadcrumb: "Chat" },
  component: ChatPage,
});

function ChatPage() {
  return (
    <WorkspacePage title="Chat" className="flex-1">
      {(workspace) => (
        <>
          <PageHeader
            title="Chat"
            description="Talk with the producer session about this workspace's videos."
          />
          <ConversationPanel workspace={workspace} />
        </>
      )}
    </WorkspacePage>
  );
}
