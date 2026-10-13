import {
  type ApiError,
  DEFAULT_PAGE_LIMIT,
  ListScheduledTasksQuerySchema,
  MAX_PAGE_LIMIT,
  routes,
  type ScheduledTask,
} from "@loomcast/contracts";
import { HttpResponse, http } from "msw";
import { type MockDb, mockId, publish } from "./db";

// The scheduler's admin routes, following the scheduler module of the API: tasks newest `runAt`
// first (the cursor is the offset of the next page), and retrying a failed or dead task, which
// answers `409 conflict` with `details.reason` `status` or `duplicate`.

const path = (name: keyof typeof routes) => `*${routes[name].path}`;

function apiError(status: number, code: string, message: string, details?: unknown) {
  return HttpResponse.json<ApiError>(
    { error: { code, message, ...(details === undefined ? {} : { details }) } },
    { status },
  );
}

const unauthorized = () => apiError(401, "unauthorized", "Sign in to continue.");

/** A task that used up its attempts, by default a dead `post.publish`. */
export function mockTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  const at = overrides.runAt ?? new Date().toISOString();
  return {
    id: mockId(),
    kind: "post.publish",
    status: "dead",
    runAt: at,
    payload: {},
    attempts: 5,
    maxAttempts: 5,
    dedupeKey: null,
    lastError: { code: "transient", message: "The platform did not answer in time.", at },
    lockedUntil: null,
    createdAt: at,
    finishedAt: at,
    ...overrides,
  };
}

/** Moves a task to `dead` and publishes `task.dead`, as the scheduler does. */
export function killTask(db: MockDb, task: ScheduledTask) {
  const at = new Date().toISOString();
  Object.assign(task, { status: "dead", finishedAt: at, attempts: task.maxAttempts });
  if (!db.tasks.includes(task)) db.tasks.push(task);
  publish(db, { type: "task.dead", payload: { task: { ...task } } });
}

export function createSchedulerHandlers(db: MockDb) {
  return [
    http.get(path("scheduler.tasks"), ({ request }) => {
      if (!db.signedIn) return unauthorized();
      const url = new URL(request.url);
      const parsed = ListScheduledTasksQuerySchema.safeParse(Object.fromEntries(url.searchParams));
      if (!parsed.success) return apiError(400, "validation_failed", "The request is not valid.");
      const { status, kind, cursor, limit } = parsed.data;
      const all = db.tasks
        .filter((task) => (!status || task.status === status) && (!kind || task.kind === kind))
        .sort((a, b) => b.runAt.localeCompare(a.runAt) || b.id.localeCompare(a.id));
      const offset = Number(cursor ?? 0) || 0;
      const size = Math.min(MAX_PAGE_LIMIT, limit ?? DEFAULT_PAGE_LIMIT);
      const items = all.slice(offset, offset + size).map((task) => ({ ...task }));
      const next = offset + size;
      return HttpResponse.json({ items, nextCursor: next < all.length ? String(next) : null });
    }),

    http.post(path("scheduler.retryTask"), ({ params }) => {
      if (!db.signedIn) return unauthorized();
      const task = db.tasks.find((entry) => entry.id === params.id);
      if (!task) return apiError(404, "not_found", "No scheduled task has that id.");
      if (task.status !== "failed" && task.status !== "dead") {
        return apiError(409, "conflict", "Only failed or dead tasks can be retried.", {
          reason: "status",
          status: task.status,
        });
      }
      if (
        task.dedupeKey !== null &&
        db.tasks.some(
          (other) =>
            other.id !== task.id &&
            other.dedupeKey === task.dedupeKey &&
            (other.status === "pending" || other.status === "running"),
        )
      ) {
        return apiError(
          409,
          "conflict",
          "Another pending or running task already holds this task's dedupe key.",
          { reason: "duplicate" },
        );
      }
      Object.assign(task, {
        status: "pending",
        runAt: new Date().toISOString(),
        attempts: 0,
        lockedUntil: null,
        finishedAt: null,
      } satisfies Partial<ScheduledTask>);
      return HttpResponse.json({ ...task });
    }),
  ];
}

const HOUR_MS = 60 * 60_000;

/** Mock mode: a few tasks the scheduler gave up on, over the demo posts and channels. */
export function seedSchedulerDemo(db: MockDb, now: number) {
  const at = (hoursAgo: number) => new Date(now - hoursAgo * HOUR_MS).toISOString();
  const post = db.posts.find((entry) => entry.status === "missed") ?? db.posts[0];
  const channel = db.channels.find((entry) => entry.status === "needs_reauth") ?? db.channels[0];
  db.tasks.push(
    mockTask({
      kind: "post.publish",
      runAt: at(5),
      finishedAt: at(5),
      payload: post ? { postId: post.id } : {},
      dedupeKey: post ? `publish:${post.id}` : null,
      lastError: {
        code: "transient",
        message: "The platform did not answer in time after 5 attempts.",
        at: at(5),
      },
    }),
    mockTask({
      kind: "channel.verify",
      runAt: at(26),
      finishedAt: at(26),
      attempts: 3,
      maxAttempts: 3,
      payload: channel ? { channelId: channel.id } : {},
      lastError: { code: "auth", message: "The access was revoked on Threads.", at: at(26) },
    }),
    mockTask({
      kind: "cadence.plan",
      status: "failed",
      runAt: at(50),
      finishedAt: at(50),
      attempts: 1,
      maxAttempts: 5,
      payload: {},
      lastError: {
        code: "invalid_payload",
        message: "The series' format has no cadence to plan.",
        at: at(50),
      },
    }),
  );
}
