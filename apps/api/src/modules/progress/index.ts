import { routes } from "@loomcast/contracts";
import { Hono } from "hono";
import type { ModuleDeps } from "../../deps";
import { notFound } from "../../lib/errors";
import { idParam } from "../../lib/http";
import type { AppEnv } from "../../types";
import { currentUser } from "../auth/guards";
import { serviceFor, workspaceExists } from "../content/support";
import { createProgressService, type ProgressService, type ProgressServiceDeps } from "./service";

export {
  createProgressService,
  type ProgressReportResult,
  type ProgressService,
  type ProgressServiceDeps,
  toContentProgress,
} from "./service";

/** The app's progress service (one per deps object), for the REST routes and the MCP tools. */
export function progressServiceFor(deps: ProgressServiceDeps): ProgressService {
  return serviceFor(deps, "progress", () => createProgressService(deps));
}

/**
 * Production progress reported by producers outside Loomcast. Reports arrive through MCP
 * (`progress.report`); the web app only reads them.
 */
export function register(app: Hono<AppEnv>, deps: ModuleDeps): Hono<AppEnv> {
  const progress = progressServiceFor(deps);
  const router = new Hono<AppEnv>();

  router.get(routes["progress.list"].path, async (c) => {
    currentUser(c);
    const workspaceId = idParam(c, "workspaceId");
    if (!(await workspaceExists(deps.db, workspaceId))) {
      throw notFound("Workspace not found.");
    }
    return c.json({ items: await progress.list(workspaceId) }, 200);
  });

  router.get(routes["progress.get"].path, async (c) => {
    currentUser(c);
    const found = await progress.get(idParam(c, "id"));
    if (found === null) {
      throw notFound("No progress was reported for that item.");
    }
    return c.json(found, 200);
  });

  app.route("/", router);
  return router;
}
