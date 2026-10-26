import { createFileRoute } from "@tanstack/react-router";
import { redirectIntoWorkspace } from "@/features/workspace/legacy";

/** Moved into each workspace: opens `/w/<workspace>/library`, keeping the filters. */
export const Route = createFileRoute("/_app/library")({
  beforeLoad: ({ context, location }) =>
    redirectIntoWorkspace(
      context.queryClient,
      location,
      "/library",
      (location.search as { workspace?: unknown }).workspace as string | undefined,
    ),
});
