import { createFileRoute, Outlet } from "@tanstack/react-router";

/** Groups the workspaces screens so their breadcrumbs start at "Workspaces". */
export const Route = createFileRoute("/_app/workspaces")({
  staticData: { breadcrumb: "Workspaces" },
  component: Outlet,
});
