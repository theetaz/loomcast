import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/PageHeader";
import { WorkspaceSkills } from "@/features/skills/WorkspaceSkills";
import { WorkspacePage } from "@/features/workspace/WorkspaceLayout";

export const Route = createFileRoute("/_app/w/$workspace/skills")({
  staticData: { breadcrumb: "Skills & tools" },
  component: WorkspaceSkillsPage,
});

function WorkspaceSkillsPage() {
  return (
    <WorkspacePage title="Skills & tools" className="max-w-[960px]">
      {(workspace) => (
        <>
          <PageHeader
            title="Skills & tools"
            description="What this workspace's content was made with, as its producers report it."
          />
          <WorkspaceSkills key={workspace.id} workspaceId={workspace.id} />
        </>
      )}
    </WorkspacePage>
  );
}
