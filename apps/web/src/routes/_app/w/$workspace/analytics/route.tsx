import { createFileRoute, Outlet } from "@tanstack/react-router";

/** Groups the analytics screens so their breadcrumbs pass through "Analytics". */
export const Route = createFileRoute("/_app/w/$workspace/analytics")({
  staticData: { breadcrumb: "Analytics" },
  component: Outlet,
});
