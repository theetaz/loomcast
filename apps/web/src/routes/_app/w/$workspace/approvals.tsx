import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/PageHeader";
import { ApprovalsInbox } from "@/features/approvals/ApprovalsInbox";
import { WorkspacePage } from "@/features/workspace/WorkspaceLayout";

export const Route = createFileRoute("/_app/w/$workspace/approvals")({
  staticData: { breadcrumb: "Approvals" },
  component: ApprovalsPage,
});

function ApprovalsPage() {
  return (
    <WorkspacePage title="Approvals" className="max-w-[960px]">
      {(workspace) => (
        <>
          <PageHeader
            title="Approvals"
            description="Videos waiting for a decision before their slot, the nearest first, and posts that missed theirs."
          />
          <ApprovalsInbox key={workspace.id} workspaceId={workspace.id} />
        </>
      )}
    </WorkspacePage>
  );
}
