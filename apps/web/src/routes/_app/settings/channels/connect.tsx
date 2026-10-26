import { createFileRoute, redirect } from "@tanstack/react-router";

/** The connect page moved out of Settings, to `/channels/connect`. */
export const Route = createFileRoute("/_app/settings/channels/connect")({
  beforeLoad: ({ location }) => {
    throw redirect({ href: `/channels/connect${location.searchStr}`, replace: true });
  },
});
