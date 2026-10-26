import { createFileRoute } from "@tanstack/react-router";
import { redirectIntoWorkspace } from "@/features/workspace/legacy";

/** Moved into each workspace: opens `/w/<workspace>/approvals`, keeping the filters. */
export const Route = createFileRoute("/_app/approvals")({
  beforeLoad: ({ context, location }) =>
    redirectIntoWorkspace(
      context.queryClient,
      location,
      "/approvals",
      (location.search as { workspace?: unknown }).workspace as string | undefined,
    ),
});
