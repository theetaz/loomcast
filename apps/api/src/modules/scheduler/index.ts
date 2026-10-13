import { Hono } from "hono";
import type { ModuleDeps } from "../../deps";
import type { AppEnv } from "../../types";

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
  type SchedulerDeps,
  type SchedulerHealth,
  type SchedulerHealthStatus,
  type TaskContext,
  TaskFailure,
  type TaskHandler,
  type TaskResult,
} from "./scheduler";

/**
 * Scheduler module. The scheduler itself is created by `createApp` and shared as
 * `deps.scheduler`; modules register their task handlers on it, and the loop runs only under
 * `startServer` with `SCHEDULER_ENABLED`. The admin endpoints are added next.
 */
export function register(app: Hono<AppEnv>, _deps: ModuleDeps): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  app.route("/", router);
  return router;
}
