import { routes } from "@loomcast/contracts";
import { Hono } from "hono";
import type { ModuleDeps } from "../../deps";
import { audit } from "../../lib/audit";
import { notFound } from "../../lib/errors";
import { clientIp, idParam } from "../../lib/http";
import type { AppEnv } from "../../types";
import { currentUser } from "../auth/guards";
import type { JobLifecycle } from "./lifecycle";
import { toJobSummary } from "./service";

/**
 * `GET /api/jobs/:id` and `POST /api/jobs/:id/cancel`. Cancelling a queued job ends it at once.
 * For a dispatched or running job the request is recorded and published as `job.updated`; the
 * bridge hub then sends `job.cancel` to the studio agent holding it (or does so when it
 * reconnects), and the job ends when the agent reports back or its lease expires.
 */
export function createJobsRouter(deps: ModuleDeps, lifecycle: JobLifecycle): Hono<AppEnv> {
  const { db, config, jobs } = deps;
  const router = new Hono<AppEnv>();

  router.get(routes["jobs.get"].path, async (c) => {
    const job = await jobs.get(idParam(c));
    if (job === null) {
      throw notFound("No such job.");
    }
    return c.json(toJobSummary(job), 200);
  });

  router.post(routes["jobs.cancel"].path, async (c) => {
    const user = currentUser(c);
    const cancelled = await lifecycle.requestCancel(idParam(c));
    if (cancelled === null) {
      throw notFound("No such job.");
    }
    if (cancelled.changed) {
      await audit(db, {
        actorKind: "user",
        actorId: user.id,
        action: "job.cancel_requested",
        targetType: "job",
        targetId: cancelled.job.id,
        data: { type: cancelled.job.type, status: cancelled.job.status },
        ip: clientIp(c, config.trustProxy),
      });
    }
    return c.json(toJobSummary(cancelled.job), 200);
  });

  return router;
}
