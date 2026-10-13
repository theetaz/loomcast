import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { SchedulerSettings } from "@/features/scheduler-admin/SchedulerSettings";
import { TASK_VIEWS } from "@/features/scheduler-admin/search";
import { useTitle } from "@/lib/use-title";

/** `?status=failed` shows failed tasks; dead tasks otherwise. */
const SchedulerSearchSchema = z.object({
  status: z.enum(TASK_VIEWS).optional().catch(undefined),
});

export const Route = createFileRoute("/_app/settings/scheduler")({
  validateSearch: SchedulerSearchSchema,
  staticData: { breadcrumb: "Scheduler" },
  component: SchedulerPage,
});

function SchedulerPage() {
  useTitle("Scheduler");
  const { status } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <SchedulerSettings
      view={status ?? "dead"}
      onViewChange={(next) =>
        void navigate({ search: next === "dead" ? {} : { status: next }, replace: true })
      }
    />
  );
}
