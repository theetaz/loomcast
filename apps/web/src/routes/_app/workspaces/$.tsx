import { createFileRoute } from "@tanstack/react-router";
import { redirectWorkspacePath } from "@/features/workspace/legacy";

/** Old workspace addresses (`/workspaces/<slug>/kb`) moved to `/w/<slug>/kb`. */
export const Route = createFileRoute("/_app/workspaces/$")({
  beforeLoad: ({ params, location }) => redirectWorkspacePath(params._splat, location),
});
