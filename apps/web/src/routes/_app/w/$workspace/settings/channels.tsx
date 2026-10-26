import { createFileRoute } from "@tanstack/react-router";
import { ChannelsSettings } from "@/features/channels/ChannelsSettings";
import { useCurrentWorkspace } from "@/features/workspace/current";
import { useWorkspaceTitle } from "@/features/workspace/WorkspaceLayout";

export const Route = createFileRoute("/_app/w/$workspace/settings/channels")({
  staticData: { breadcrumb: "Channels" },
  component: ChannelsPage,
});

function ChannelsPage() {
  useWorkspaceTitle("Channels");
  const workspace = useCurrentWorkspace();
  return <ChannelsSettings key={workspace.id} workspace={workspace} />;
}
