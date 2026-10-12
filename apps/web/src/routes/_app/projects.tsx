import { createFileRoute, Outlet } from "@tanstack/react-router";

/** Groups the projects screens so their breadcrumbs start at "Projects". */
export const Route = createFileRoute("/_app/projects")({
  staticData: { breadcrumb: "Projects" },
  component: Outlet,
});
