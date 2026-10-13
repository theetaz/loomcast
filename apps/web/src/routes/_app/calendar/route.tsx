import { createFileRoute, Outlet } from "@tanstack/react-router";

/** Groups the calendar screens so their breadcrumbs start at "Calendar". */
export const Route = createFileRoute("/_app/calendar")({
  staticData: { breadcrumb: "Calendar" },
  component: Outlet,
});
