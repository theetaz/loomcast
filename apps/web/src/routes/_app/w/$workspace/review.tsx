import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/PageHeader";
import { ReviewQueue } from "@/features/review-queue/ReviewQueue";
import { WorkspacePage } from "@/features/workspace/WorkspaceLayout";

export const Route = createFileRoute("/_app/w/$workspace/review")({
  staticData: { breadcrumb: "Review" },
  component: ReviewPage,
});

function ReviewPage() {
  return (
    <WorkspacePage title="Review" className="max-w-[960px]">
      {(workspace) => (
        <>
          <PageHeader
            title="Review"
            description="Videos waiting for your decision, the nearest publishing date first."
          />
          <ReviewQueue key={workspace.id} workspaceId={workspace.id} />
        </>
      )}
    </WorkspacePage>
  );
}
