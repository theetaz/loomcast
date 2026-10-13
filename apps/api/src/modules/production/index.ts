import { ContentActionRequestSchema, routes } from "@loomcast/contracts";
import { Hono } from "hono";
import type { ModuleDeps } from "../../deps";
import { idParam, readJson } from "../../lib/http";
import type { AppEnv } from "../../types";
import { currentUser } from "../auth/guards";
import { contentServiceFor, userActor } from "../content";
import { serviceFor } from "../content/support";
import { toJobSummary } from "../jobs/service";
import {
  createProductionService,
  type ProductionService,
  type ProductionServiceDeps,
} from "./service";

export { createProductionJobHooks } from "./hooks";
export {
  type AutopilotMove,
  autopilotMove,
  createProductionService,
  type ProductionService,
  type ProductionServiceDeps,
  STEP_JOB_TYPES,
  stepKey,
} from "./service";
export {
  fitStoryboard,
  RENDER_LENGTH_TOLERANCE,
  renderLengthNote,
  segmentSpans,
  timeScript,
} from "./timing";

/** The app's production service (one per deps object). */
export function productionServiceFor(
  deps: Pick<ModuleDeps, "db" | "bus" | "jobs" | "assets">,
): ProductionService {
  return serviceFor(deps, "production", () => {
    const serviceDeps: ProductionServiceDeps = {
      db: deps.db,
      bus: deps.bus,
      jobs: deps.jobs,
      assets: deps.assets,
      content: contentServiceFor(deps),
    };
    return createProductionService(serviceDeps);
  });
}

/**
 * Production endpoints: content actions that start production jobs. Job results become versions
 * in the job hooks (`createProductionJobHooks`, registered in `modules/jobs/handlers`).
 */
export function register(app: Hono<AppEnv>, deps: ModuleDeps): Hono<AppEnv> {
  const production = productionServiceFor(deps);
  const router = new Hono<AppEnv>();
  const trustProxy = deps.config.trustProxy;

  router.post(routes["content.actions"].path, async (c) => {
    const user = currentUser(c);
    const request = await readJson(c, ContentActionRequestSchema);
    const job = await production.start(idParam(c), request, userActor(c, trustProxy), user.role);
    return c.json(toJobSummary(job), 201);
  });

  app.route("/", router);
  return router;
}
