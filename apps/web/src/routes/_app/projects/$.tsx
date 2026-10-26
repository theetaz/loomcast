import { createFileRoute } from "@tanstack/react-router";
import { redirectWorkspacePath } from "@/features/workspace/legacy";

/** Projects became workspaces: `/projects/<slug>/kb` opens `/w/<slug>/kb`. */
export const Route = createFileRoute("/_app/projects/$")({
  beforeLoad: ({ params, location }) => redirectWorkspacePath(params._splat, location),
});
