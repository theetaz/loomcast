import { createFileRoute } from "@tanstack/react-router";
import { redirectIntoWorkspace } from "@/features/workspace/legacy";

/** Moved into each workspace: opens `/w/<workspace>/calendar`, keeping the filters. */
export const Route = createFileRoute("/_app/calendar")({
  beforeLoad: ({ context, location }) =>
    redirectIntoWorkspace(
      context.queryClient,
      location,
      "/calendar",
      (location.search as { workspace?: unknown }).workspace as string | undefined,
    ),
});
