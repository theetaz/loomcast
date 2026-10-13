import { createFileRoute, Outlet } from "@tanstack/react-router";

/** Groups the series pages so their breadcrumbs pass through "Series". */
export const Route = createFileRoute("/_app/projects/$projectId/series")({
  staticData: { breadcrumb: "Series" },
  component: Outlet,
});
