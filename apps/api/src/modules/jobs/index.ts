import type { Hono } from "hono";
import type { ModuleDeps } from "../../deps";
import type { AppEnv } from "../../types";
import { createJobLifecycle } from "./lifecycle";
import { createJobsRouter } from "./routes";

export { createDispatcher, type Dispatcher, type DispatchTarget } from "./dispatcher";
export {
  createJobHooks,
  createKbAnalyzeReferenceHooks,
  createKbCompetitorReportHooks,
  createProducerChatHooks,
  type JobHandlerDeps,
  subscribeJobStatusHooks,
} from "./handlers";
export type { JobHooks, JobTypeHooks } from "./hooks";
export {
  CANCELLED_ERROR,
  createJobLifecycle,
  defaultJobHooks,
  INTERRUPTED_ERROR,
  type JobLifecycle,
} from "./lifecycle";
export { createReaper, type Reaper } from "./reaper";
export {
  createJobsService,
  type EnqueueInput,
  type EnqueueResult,
  type JobsService,
  toJobSummary,
} from "./service";
export { isTerminalStatus, type JobAction, nextStatus } from "./transitions";

/**
 * Job endpoints (`GET /api/jobs/:id`, `POST /api/jobs/:id/cancel`). The jobs service itself is
 * created by `createApp` and shared as `deps.jobs`; dispatch, events and leases live in the
 * bridge module, which owns the studio agent connections.
 */
export function register(app: Hono<AppEnv>, deps: ModuleDeps): Hono<AppEnv> {
  const router = createJobsRouter(deps, createJobLifecycle(deps));
  app.route("/", router);
  return router;
}
