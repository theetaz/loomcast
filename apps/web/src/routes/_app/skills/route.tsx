import { createFileRoute, Outlet } from "@tanstack/react-router";

/** Groups the skills catalogue's pages so their breadcrumbs start at "Skills". */
export const Route = createFileRoute("/_app/skills")({
  staticData: { breadcrumb: "Skills" },
  component: Outlet,
});
