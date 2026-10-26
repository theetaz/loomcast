import { createFileRoute } from "@tanstack/react-router";
import { useCurrentWorkspace } from "@/features/workspace/current";
import { useWorkspaceTitle } from "@/features/workspace/WorkspaceLayout";
import { GeneralSettings } from "@/features/workspace-settings/GeneralSettings";

export const Route = createFileRoute("/_app/w/$workspace/settings/")({
  component: GeneralPage,
});

function GeneralPage() {
  useWorkspaceTitle("Settings");
  const workspace = useCurrentWorkspace();
  return <GeneralSettings key={workspace.id} workspace={workspace} />;
}
