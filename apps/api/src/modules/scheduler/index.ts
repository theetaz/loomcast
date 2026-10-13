import {
  DEFAULT_PAGE_LIMIT,
  ListScheduledTasksQuerySchema,
  routes,
  type ScheduledTask,
} from "@loomcast/contracts";
import { retryTask, scheduledTasks } from "@loomcast/db";
import { and, desc, eq, type SQL, sql } from "drizzle-orm";
import { type Context, Hono } from "hono";
import type { ModuleDeps } from "../../deps";
import { audit } from "../../lib/audit";
import { isUniqueViolation, transaction } from "../../lib/db";
import { conflict, forbidden, notFound, validationFailed } from "../../lib/errors";
import { clientIp, idParam, issueDetails } from "../../lib/http";
import type { AppEnv, AuthUser } from "../../types";
import { currentUser } from "../auth/guards";
import { toScheduledTask } from "./mappers";

export { toScheduledTask } from "./mappers";
export {
  createScheduler,
  type EnqueueOptions,
  RECURRING_TASKS,
  type RegisterTaskOptions,
  recurringDedupeKey,
  SCHEDULER_CLAIM_BATCH,
  SCHEDULER_MAX_IN_FLIGHT,
  SCHEDULER_STOP_TIMEOUT_MS,
  type Scheduler,
  type SchedulerAlert,
  type SchedulerDeps,
  type SchedulerHealth,
  type SchedulerHealthStatus,
  type TaskContext,
  TaskFailure,
  type TaskHandler,
  type TaskResult,
} from "./scheduler";

const CURSOR_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z)_([0-9a-f-]{36})$/;

/** `run_at` with microseconds, so a cursor never skips rows that share a millisecond. */
const cursorTimestamp = sql<string>`to_char(${scheduledTasks.runAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

function encodeCursor(timestamp: string, id: string): string {
  return Buffer.from(`${timestamp}_${id}`, "utf8").toString("base64url");
}

function decodeCursor(cursor: string): { timestamp: string; id: string } {
  const match = CURSOR_RE.exec(Buffer.from(cursor, "base64url").toString("utf8"));
  if (match === null || match[1] === undefined || match[2] === undefined) {
    throw validationFailed([{ path: "cursor", message: "Unknown cursor" }]);
  }
  return { timestamp: match[1], id: match[2] };
}

/** The signed-in user, who must be the owner or an admin. */
function currentAdmin(c: Context<AppEnv>): AuthUser {
  const user = currentUser(c);
  if (user.role !== "owner" && user.role !== "admin") {
    throw forbidden("Only the owner and admins can manage scheduled tasks.");
  }
  return user;
}

/**
 * Scheduler admin endpoints: `GET /api/scheduler/tasks` (filter by status and kind, newest `runAt`
 * first) and `POST /api/scheduler/tasks/:id/retry` for a `failed` or `dead` task. The scheduler
 * itself is created by `createApp` and shared as `deps.scheduler`; modules register their task
 * handlers on it, and the loop runs only under `startServer` with `SCHEDULER_ENABLED`.
 */
export function register(app: Hono<AppEnv>, deps: ModuleDeps): Hono<AppEnv> {
  const { db, scheduler } = deps;
  const router = new Hono<AppEnv>();

  router.get(routes["scheduler.tasks"].path, async (c) => {
    currentAdmin(c);
    const parsed = ListScheduledTasksQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      throw validationFailed(issueDetails(parsed.error));
    }
    const query = parsed.data;
    const limit = query.limit ?? DEFAULT_PAGE_LIMIT;
    const conditions: (SQL | undefined)[] = [];
    if (query.status !== undefined) {
      conditions.push(eq(scheduledTasks.status, query.status));
    }
    if (query.kind !== undefined) {
      conditions.push(eq(scheduledTasks.kind, query.kind));
    }
    if (query.cursor !== undefined) {
      const cursor = decodeCursor(query.cursor);
      conditions.push(
        sql`(${scheduledTasks.runAt}, ${scheduledTasks.id}) < (${cursor.timestamp}::timestamptz, ${cursor.id}::uuid)`,
      );
    }
    const rows = await db
      .select({ task: scheduledTasks, cursorAt: cursorTimestamp })
      .from(scheduledTasks)
      .where(and(...conditions))
      .orderBy(desc(scheduledTasks.runAt), desc(scheduledTasks.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    const items: ScheduledTask[] = page.map((row) => toScheduledTask(row.task));
    c.header("Cache-Control", "no-store");
    return c.json(
      {
        items,
        nextCursor:
          rows.length > limit && last !== undefined
            ? encodeCursor(last.cursorAt, last.task.id)
            : null,
      },
      200,
    );
  });

  router.post(routes["scheduler.retryTask"].path, async (c) => {
    const user = currentAdmin(c);
    const id = idParam(c);
    let task: ScheduledTask | null;
    try {
      task = await transaction(db, async (tx) => {
        const row = await retryTask(tx, { id, now: deps.clock.now() });
        if (row === null) {
          return null;
        }
        await audit(tx, {
          actorKind: "user",
          actorId: user.id,
          action: "scheduler.task.retried",
          targetType: "scheduled_task",
          targetId: row.id,
          data: { kind: row.kind },
          ip: clientIp(c, deps.config.trustProxy),
        });
        return toScheduledTask(row);
      });
    } catch (error) {
      if (isUniqueViolation(error, "scheduled_tasks_dedupe_key_uq")) {
        throw conflict("Another pending or running task already holds this task's dedupe key.", {
          reason: "duplicate",
        });
      }
      throw error;
    }
    if (task === null) {
      const [existing] = await db
        .select({ status: scheduledTasks.status })
        .from(scheduledTasks)
        .where(eq(scheduledTasks.id, id));
      if (existing === undefined) {
        throw notFound("No scheduled task has that id.");
      }
      throw conflict("Only failed or dead tasks can be retried.", {
        reason: "status",
        status: existing.status,
      });
    }
    scheduler.wake();
    return c.json(task, 200);
  });

  app.route("/", router);
  return router;
}
