import { createFileRoute } from "@tanstack/react-router";
import { redirectIntoWorkspace } from "@/features/workspace/legacy";

/** Moved into each workspace: opens `/w/<workspace>/review`, keeping the filters. */
export const Route = createFileRoute("/_app/review")({
  beforeLoad: ({ context, location }) =>
    redirectIntoWorkspace(
      context.queryClient,
      location,
      "/review",
      (location.search as { workspace?: unknown }).workspace as string | undefined,
    ),
});
