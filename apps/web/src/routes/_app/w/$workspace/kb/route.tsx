import { createFileRoute, Outlet } from "@tanstack/react-router";

/** Groups the knowledge pages so their breadcrumbs pass through "Knowledge". */
export const Route = createFileRoute("/_app/w/$workspace/kb")({
  staticData: { breadcrumb: "Knowledge" },
  component: Outlet,
});
