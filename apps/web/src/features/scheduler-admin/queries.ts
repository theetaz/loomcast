import type { CursorPage, ScheduledTask, ScheduledTaskKind } from "@loomcast/contracts";
import {
  type InfiniteData,
  infiniteQueryOptions,
  type QueryClient,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { api, isApiError } from "@/lib/api";
import { useLiveEvent } from "@/lib/live";
import type { TaskView } from "./search";

export const TASK_PAGE_SIZE = 50;

export const schedulerKeys = {
  all: ["scheduler", "tasks"] as const,
  list: (status: TaskView) => ["scheduler", "tasks", status] as const,
};

export type TaskPages = InfiniteData<CursorPage<ScheduledTask>, string | undefined>;

export function tasksQueryOptions(status: TaskView) {
  return infiniteQueryOptions({
    queryKey: schedulerKeys.list(status),
    queryFn: ({ pageParam, signal }) =>
      api.request("scheduler.tasks", {
        query: { status, limit: TASK_PAGE_SIZE, ...(pageParam ? { cursor: pageParam } : {}) },
        signal,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    staleTime: 0,
  });
}

const KIND_LABELS: Record<ScheduledTaskKind, string> = {
  "cadence.plan": "Plan cadence slots",
  "cadence.produce": "Produce for a slot",
  "post.publish": "Publish a post",
  "post.check_status": "Check a post's status",
  "assets.cleanup": "Clean up uploads",
  "channel.refresh_token": "Refresh channel access",
  "channel.verify": "Verify channel access",
  "insights.pull": "Pull post insights",
};

export function taskKindLabel(kind: ScheduledTaskKind): string {
  return KIND_LABELS[kind] ?? kind;
}

/**
 * What a task is about, from the ids in its payload: `post 1a2b3c4d`. Payloads hold ids only, so
 * nothing private is shown. Tasks for everything (a daily sweep) say so.
 */
export function taskTarget(task: Pick<ScheduledTask, "payload">): string {
  const parts = Object.entries(task.payload)
    .filter(([key, value]) => key.endsWith("Id") && typeof value === "string")
    .map(([key, value]) => `${key.slice(0, -2)} ${String(value).slice(0, 8)}`);
  return parts.length > 0 ? parts.join(", ") : "All";
}

function mapPages(data: TaskPages, update: (items: ScheduledTask[]) => ScheduledTask[]) {
  return { ...data, pages: data.pages.map((page) => ({ ...page, items: update(page.items) })) };
}

/** Takes a task out of every loaded list. */
export function removeTask(queryClient: QueryClient, id: string) {
  for (const [queryKey, data] of queryClient.getQueriesData<TaskPages>({
    queryKey: schedulerKeys.all,
  })) {
    if (!data?.pages.some((page) => page.items.some((task) => task.id === id))) continue;
    queryClient.setQueryData<TaskPages>(
      queryKey,
      mapPages(data, (items) => items.filter((task) => task.id !== id)),
    );
  }
}

/** A task that just died joins the top of the loaded dead list (newest `runAt` first). */
export function addDeadTask(queryClient: QueryClient, task: ScheduledTask) {
  const key = schedulerKeys.list("dead");
  const data = queryClient.getQueryData<TaskPages>(key);
  if (!data) return;
  const rest = mapPages(data, (items) => items.filter((entry) => entry.id !== task.id));
  queryClient.setQueryData<TaskPages>(key, {
    ...rest,
    pages: rest.pages.map((page, index) =>
      index === 0 ? { ...page, items: [task, ...page.items] } : page,
    ),
  });
}

/** Adds tasks to the dead list as the scheduler gives up on them. */
export function useSchedulerLive() {
  const queryClient = useQueryClient();
  useLiveEvent("task.dead", (event) => addDeadTask(queryClient, event.payload.task));
}

/** Why a retry was refused, from `409 conflict` details. */
export function retryRefusal(error: unknown): string | null {
  if (!isApiError(error, 409)) return null;
  const details = (error.details ?? {}) as { reason?: string; status?: string };
  if (details.reason === "duplicate") {
    return "Another run of this task is already waiting or running.";
  }
  if (details.reason === "status") {
    return details.status
      ? `Only failed or dead tasks can be retried. This one is ${details.status} now.`
      : "Only failed or dead tasks can be retried.";
  }
  return error.message;
}

/**
 * Runs a failed or dead task again now, with a fresh set of attempts. It leaves the list it was
 * in; a refusal refetches, since the task changed meanwhile.
 */
export function useRetryTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (task: ScheduledTask) =>
      api.request("scheduler.retryTask", { params: { id: task.id } }),
    onSuccess: (task) => removeTask(queryClient, task.id),
    onError: (error) => {
      if (isApiError(error, 409) || isApiError(error, 404)) {
        void queryClient.invalidateQueries({ queryKey: schedulerKeys.all });
      }
    },
  });
}
