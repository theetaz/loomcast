import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/PageHeader";
import { ProductionBoard } from "@/features/production/ProductionBoard";
import { WorkspacePage } from "@/features/workspace/WorkspaceLayout";

export const Route = createFileRoute("/_app/w/$workspace/production")({
  staticData: { breadcrumb: "Production" },
  component: ProductionPage,
});

function ProductionPage() {
  return (
    <WorkspacePage title="Production" className="max-w-[1240px]">
      {(workspace) => (
        <>
          <PageHeader
            title="Production"
            description="How this workspace's content is being made, step by step, as its producers report it."
          />
          <ProductionBoard key={workspace.id} workspaceId={workspace.id} />
        </>
      )}
    </WorkspacePage>
  );
}
