import { createFileRoute, redirect } from "@tanstack/react-router";
import { WorkspacePage } from "@/features/workspace/WorkspaceLayout";
import { WorkspaceOverview } from "@/features/workspace/WorkspaceOverview";

export const Route = createFileRoute("/_app/w/$workspace/")({
  // Links to a conversation (`?conversation=`) point at the workspace; they open in Chat.
  beforeLoad: ({ params, search }) => {
    if (search.conversation) {
      throw redirect({
        to: "/w/$workspace/chat",
        params,
        search: { conversation: search.conversation },
        replace: true,
      });
    }
  },
  component: OverviewPage,
});

function OverviewPage() {
  return (
    <WorkspacePage>{(workspace) => <WorkspaceOverview workspace={workspace} />}</WorkspacePage>
  );
}
