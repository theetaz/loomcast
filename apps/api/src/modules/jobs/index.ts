import { Hono } from "hono";
import type { ModuleDeps } from "../../deps";
import type { AppEnv } from "../../types";

export {
  createJobsService,
  type EnqueueInput,
  type EnqueueResult,
  type JobsService,
  toJobSummary,
} from "./service";

/**
 * Job endpoints (`GET /api/jobs/:id`, `POST /api/jobs/:id/cancel`). Not implemented yet: the
 * router is mounted empty so `createApp` already registers the module. The jobs service itself
 * is created by `createApp` and shared as `deps.jobs`.
 */
export function register(app: Hono<AppEnv>, _deps: ModuleDeps): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  app.route("/", router);
  return router;
}
