import { createFileRoute, Outlet } from "@tanstack/react-router";

/** Groups the competitor pages so their breadcrumbs pass through "Competitors". */
export const Route = createFileRoute("/_app/w/$workspace/competitors")({
  staticData: { breadcrumb: "Competitors" },
  component: Outlet,
});
