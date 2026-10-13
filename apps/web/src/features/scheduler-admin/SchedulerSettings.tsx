import type { ScheduledTask } from "@loomcast/contracts";
import { Button } from "@loomcast/ui/components/button";
import { cn } from "@loomcast/ui/lib/cn";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { CircleCheckIcon, RotateCcwIcon } from "lucide-react";
import { toast } from "sonner";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { RelativeTime } from "@/components/RelativeTime";
import { PublisherBanner } from "@/features/channels/PublisherBanner";
import { publisherStatusQueryOptions } from "@/features/channels/queries";
import { SettingsCard, TableSkeleton, td, th } from "@/features/settings/SettingsCard";
import { errorMessage } from "@/lib/api";
import { useNow } from "@/lib/use-now";
import {
  retryRefusal,
  taskKindLabel,
  tasksQueryOptions,
  taskTarget,
  useRetryTask,
  useSchedulerLive,
} from "./queries";
import { TASK_VIEWS, type TaskView } from "./search";

const VIEW_LABELS: Record<TaskView, string> = { dead: "Dead", failed: "Failed" };

const EMPTY: Record<TaskView, { title: string; description: string }> = {
  dead: {
    title: "No dead tasks",
    description: "A task lands here when every attempt failed. Retry it once the cause is fixed.",
  },
  failed: {
    title: "No failed tasks",
    description: "A task lands here when it hit an error that retrying on its own can't fix.",
  },
};

/** A scheduler that hasn't ticked for this long is worth a look. */
const STALE_TICK_MS = 5 * 60_000;

/**
 * Settings → Scheduler: the scheduler's last run and the server's publishing switches, and the
 * tasks it gave up on (dead, or failed for good) with their last error and a Retry button.
 */
export function SchedulerSettings({
  view,
  onViewChange,
}: {
  view: TaskView;
  onViewChange: (view: TaskView) => void;
}) {
  useSchedulerLive();
  const query = useInfiniteQuery(tasksQueryOptions(view));
  const tasks = query.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <div className="flex flex-col gap-3">
      <PublisherBanner />
      <SchedulerHealth />
      <SettingsCard
        title="Tasks needing attention"
        count={query.isSuccess ? tasks.length : null}
        busy={query.isPending}
        action={
          // biome-ignore lint/a11y/useSemanticElements: a group of toggle buttons, not a fieldset
          <div role="group" aria-label="Task status" className="flex rounded-md bg-secondary p-0.5">
            {TASK_VIEWS.map((entry) => (
              <button
                key={entry}
                type="button"
                aria-pressed={view === entry}
                onClick={() => onViewChange(entry)}
                className={cn(
                  "h-6 rounded-[5px] px-2.5 font-medium text-[12px] outline-none transition-[background-color,color,box-shadow] duration-150 ease-[cubic-bezier(.23,1,.32,1)] focus-visible:ring-2 focus-visible:ring-ring",
                  view === entry
                    ? "bg-card text-foreground shadow-card"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {VIEW_LABELS[entry]}
              </button>
            ))}
          </div>
        }
      >
        {query.isPending ? (
          <TableSkeleton columns={["w-24", "w-40", "w-12", "w-14"]} />
        ) : query.isError ? (
          <ErrorState
            size="compact"
            title="Couldn't load scheduled tasks"
            error={query.error}
            onRetry={() => void query.refetch()}
            retrying={query.isFetching}
          />
        ) : tasks.length === 0 ? (
          <EmptyState
            size="compact"
            icon={CircleCheckIcon}
            title={EMPTY[view].title}
            description={EMPTY[view].description}
          />
        ) : (
          <table aria-label={`${VIEW_LABELS[view]} tasks`} className="w-full table-fixed text-left">
            <thead>
              <tr className="h-9 border-divider border-b">
                <th scope="col" className={th("w-[34%] pl-3.5 md:w-[24%]")}>
                  Task
                </th>
                <th scope="col" className={th("hidden w-[16%] md:table-cell")}>
                  For
                </th>
                <th scope="col" className={th("hidden w-[72px] sm:table-cell")}>
                  Attempts
                </th>
                <th scope="col" className={th()}>
                  Last error
                </th>
                <th scope="col" className={th("hidden w-[64px] text-right sm:table-cell")}>
                  When
                </th>
                <th scope="col" className={th("w-[84px] pr-3")}>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((task) => (
                <TaskRow key={task.id} task={task} />
              ))}
            </tbody>
          </table>
        )}
        {query.hasNextPage ? (
          <div className="flex justify-center border-divider border-t px-3.5 py-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
            >
              {query.isFetchingNextPage ? "Loading…" : "Load more"}
            </Button>
          </div>
        ) : null}
      </SettingsCard>
    </div>
  );
}

function SchedulerHealth() {
  const now = useNow();
  const { data } = useQuery(publisherStatusQueryOptions());
  if (!data) return null;
  const stale = data.lastTickAt !== null && now - Date.parse(data.lastTickAt) > STALE_TICK_MS;
  return (
    <p className="px-1 text-control text-muted-foreground">
      {data.lastTickAt === null ? (
        <span className="text-status-amber">The scheduler hasn't run yet.</span>
      ) : (
        <span className={stale ? "text-status-amber" : undefined}>
          The scheduler last ran <RelativeTime value={data.lastTickAt} format="relative" />
          {stale ? ". Check that the server is running." : "."}
        </span>
      )}{" "}
      Publishing is {data.mode === "live" ? "live" : "dry-run"}
      {data.enabled ? "" : " and paused"}.
    </p>
  );
}

function TaskRow({ task }: { task: ScheduledTask }) {
  // One mutation per row, so retries on several rows run side by side.
  const retry = useRetryTask();
  const label = taskKindLabel(task.kind);
  const when = task.finishedAt ?? task.runAt;

  const onRetry = () =>
    retry.mutate(task, {
      onSuccess: () => toast.success("Task queued again", { description: label }),
      onError: (error) =>
        toast.error("Couldn't retry the task", {
          description: retryRefusal(error) ?? errorMessage(error),
        }),
    });

  return (
    <tr className="border-divider border-t align-top first:border-t-0" data-task-id={task.id}>
      <td className={td("py-2 pl-3.5")}>
        <span className="block truncate text-body text-foreground">{label}</span>
        <span className="block truncate font-mono text-[11px] text-muted-foreground">
          {task.kind}
        </span>
      </td>
      <td className={td("hidden py-2 md:table-cell")}>
        <span className="block truncate font-mono text-[11.5px] text-text-2">
          {taskTarget(task)}
        </span>
      </td>
      <td className={td("hidden py-2 sm:table-cell")}>
        <span className="font-mono text-[11.5px] text-text-2 tabular-nums">
          {task.attempts}/{task.maxAttempts}
        </span>
      </td>
      <td className={td("py-2")}>
        {task.lastError ? (
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="font-mono text-[11px] text-status-red">{task.lastError.code}</span>
            <span className="line-clamp-2 break-words text-small text-text-2">
              {task.lastError.message}
            </span>
          </span>
        ) : (
          <span className="text-small text-muted-foreground">No error recorded</span>
        )}
      </td>
      <td className={td("hidden py-2 text-right sm:table-cell")}>
        <RelativeTime value={when} className="font-mono text-[11px] text-muted-foreground" />
      </td>
      <td className={td("py-1.5 pr-3 text-right")}>
        <Button
          size="sm"
          variant="outline"
          disabled={retry.isPending}
          onClick={onRetry}
          aria-label={`Retry ${label}`}
        >
          <RotateCcwIcon aria-hidden="true" />
          {retry.isPending ? "Retrying…" : "Retry"}
        </Button>
      </td>
    </tr>
  );
}
