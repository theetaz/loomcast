import type { Database } from "@loomcast/db";
import type { EventBus } from "../../lib/bus";
import type { JobHooks, JobTypeHooks } from "../jobs/hooks";
import { createProductionService, type ProductionService, STEP_JOB_TYPES } from "./service";

/**
 * Side effects of the production job types (`content.write_script`, `content.storyboard`,
 * `content.voice`, `content.render`, `content.revise`):
 * - succeeded: the result becomes the item's next version, in the job's own transaction and at
 *   most once per job, and autopilot queues the next step (see `ProductionService.applyResult`);
 * - failed or cancelled: the item records the error (`lastError`, published as
 *   `content.item.updated`) and autopilot stops.
 */
export function createProductionJobHooks(
  deps: { db: Database; bus: EventBus },
  service: ProductionService = createProductionService(deps),
): JobHooks {
  const hooks: JobTypeHooks = {
    onSucceeded: (tx, job, result) => service.applyResult(tx, job, result),
    async onStatusChanged(job) {
      if (job.status === "failed" || job.status === "cancelled") {
        await service.recordFailure(job.id);
      }
    },
  };
  return Object.fromEntries(Object.values(STEP_JOB_TYPES).map((type) => [type, hooks]));
}
