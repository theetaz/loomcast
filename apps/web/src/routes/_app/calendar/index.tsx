import { createFileRoute } from "@tanstack/react-router";
import { CalendarPage } from "@/features/calendar/CalendarPage";
import { CalendarSearchSchema } from "@/features/calendar/search";

export const Route = createFileRoute("/_app/calendar/")({
  validateSearch: CalendarSearchSchema,
  component: CalendarRoute,
});

function CalendarRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <CalendarPage
      search={search}
      onSearchChange={(update) => void navigate({ search: update, replace: true })}
    />
  );
}
