import { createFileRoute, redirect } from "@tanstack/react-router";

/** The old Content tab: its items are in the library now. */
export const Route = createFileRoute("/_app/w/$workspace/content/")({
  beforeLoad: ({ params }) => {
    throw redirect({ to: "/w/$workspace/library", params, replace: true });
  },
});
