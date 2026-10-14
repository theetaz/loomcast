import { createFileRoute, Outlet } from "@tanstack/react-router";

/** Groups the guide's pages so their breadcrumbs start at "Guide". */
export const Route = createFileRoute("/_app/guide")({
  staticData: { breadcrumb: "Guide" },
  component: Outlet,
});
