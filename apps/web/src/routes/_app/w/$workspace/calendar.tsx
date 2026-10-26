import { createFileRoute } from "@tanstack/react-router";
import { CalendarPage } from "@/features/calendar/CalendarPage";
import { CalendarSearchSchema } from "@/features/calendar/search";
import { useCurrentWorkspace } from "@/features/workspace/current";

export const Route = createFileRoute("/_app/w/$workspace/calendar")({
  validateSearch: CalendarSearchSchema,
  staticData: { breadcrumb: "Calendar" },
  component: CalendarRoute,
});

function CalendarRoute() {
  const workspace = useCurrentWorkspace();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <CalendarPage
      key={workspace.id}
      workspace={workspace}
      search={search}
      onSearchChange={(update) => void navigate({ search: update, replace: true })}
    />
  );
}
