import { createFileRoute, Outlet } from "@tanstack/react-router";

/** Groups the library screens so their breadcrumbs start at "Library". */
export const Route = createFileRoute("/_app/library")({
  staticData: { breadcrumb: "Library" },
  component: Outlet,
});
