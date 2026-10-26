import { createFileRoute, redirect } from "@tanstack/react-router";
import { resolveHomeWorkspace } from "@/features/workspace/home";

/** Opens the remembered workspace, else the most recent active one, else the workspace list. */
export const Route = createFileRoute("/_app/")({
  beforeLoad: async ({ context }) => {
    const workspace = await resolveHomeWorkspace(context.queryClient);
    if (!workspace) throw redirect({ to: "/workspaces", replace: true });
    throw redirect({ to: "/w/$workspace", params: { workspace: workspace.slug }, replace: true });
  },
});
