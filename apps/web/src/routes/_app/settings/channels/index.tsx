import { createFileRoute } from "@tanstack/react-router";
import { redirectIntoWorkspace } from "@/features/workspace/legacy";

/** Channels belong to a workspace now: opens its channel settings. */
export const Route = createFileRoute("/_app/settings/channels/")({
  beforeLoad: ({ context, location }) =>
    redirectIntoWorkspace(context.queryClient, location, "/settings/channels"),
});
