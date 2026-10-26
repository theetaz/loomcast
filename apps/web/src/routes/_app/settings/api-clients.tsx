import { createFileRoute } from "@tanstack/react-router";
import { redirectIntoWorkspace } from "@/features/workspace/legacy";

/** API clients belong to a workspace now: opens its API client settings. */
export const Route = createFileRoute("/_app/settings/api-clients")({
  beforeLoad: ({ context, location }) =>
    redirectIntoWorkspace(context.queryClient, location, "/settings/api-clients"),
});
