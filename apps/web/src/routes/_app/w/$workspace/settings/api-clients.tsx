import { createFileRoute } from "@tanstack/react-router";
import { ApiClientsSettings } from "@/features/api-clients/ApiClientsSettings";
import { useCurrentWorkspace } from "@/features/workspace/current";
import { useWorkspaceTitle } from "@/features/workspace/WorkspaceLayout";

export const Route = createFileRoute("/_app/w/$workspace/settings/api-clients")({
  staticData: { breadcrumb: "API clients" },
  component: ApiClientsPage,
});

function ApiClientsPage() {
  useWorkspaceTitle("API clients");
  const workspace = useCurrentWorkspace();
  return <ApiClientsSettings key={workspace.id} workspace={workspace} />;
}
