import { createFileRoute, Outlet } from "@tanstack/react-router";

/** Groups the analytics screens so their breadcrumbs start at "Analytics". */
export const Route = createFileRoute("/_app/analytics")({
  staticData: { breadcrumb: "Analytics" },
  component: Outlet,
});
