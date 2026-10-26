import { createFileRoute, Outlet } from "@tanstack/react-router";
import { PageHeader } from "@/components/PageHeader";
import { WorkspacePage } from "@/features/workspace/WorkspaceLayout";
import { WorkspaceSettingsTabs } from "@/features/workspace-settings/WorkspaceSettingsTabs";

export const Route = createFileRoute("/_app/w/$workspace/settings")({
  staticData: { breadcrumb: "Settings" },
  component: WorkspaceSettingsLayout,
});

function WorkspaceSettingsLayout() {
  return (
    <WorkspacePage title={null}>
      {(workspace) => (
        <>
          <PageHeader
            title="Workspace settings"
            description={`How ${workspace.name} looks, the channels it publishes to and the backends that post through it.`}
          />
          <WorkspaceSettingsTabs>
            <Outlet />
          </WorkspaceSettingsTabs>
        </>
      )}
    </WorkspacePage>
  );
}
