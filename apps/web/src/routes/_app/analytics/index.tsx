import { createFileRoute } from "@tanstack/react-router";
import { redirectIntoWorkspace } from "@/features/workspace/legacy";

/** Moved into each workspace: opens `/w/<workspace>/analytics`, keeping the range. */
export const Route = createFileRoute("/_app/analytics/")({
  beforeLoad: ({ context, location }) =>
    redirectIntoWorkspace(
      context.queryClient,
      location,
      "/analytics",
      (location.search as { workspace?: unknown }).workspace as string | undefined,
    ),
});
