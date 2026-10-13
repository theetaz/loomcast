import {
  CreateSeriesRequestSchema,
  ListSeriesQuerySchema,
  routes,
  UpdateSeriesRequestSchema,
} from "@loomcast/contracts";
import { type Context, Hono } from "hono";
import type { ModuleDeps } from "../../deps";
import { notFound, validationFailed } from "../../lib/errors";
import { idParam, issueDetails, readJson } from "../../lib/http";
import type { AppEnv } from "../../types";
import { currentUser } from "../auth/guards";
import { userActor } from "../content/actor";
import { serviceFor } from "../content/support";
import {
  createSeriesService,
  type SeriesService,
  type SeriesServiceDeps,
  type SeriesStatusMove,
} from "./service";

export {
  createSeriesService,
  FALLBACK_SERIES_SLUG,
  type SeriesService,
  type SeriesServiceDeps,
  type SeriesStatusMove,
  toSeries,
} from "./service";

/** The app's series service (one per deps object), for other modules and the MCP tools. */
export function seriesServiceFor(deps: SeriesServiceDeps): SeriesService {
  return serviceFor(deps, "series", () => createSeriesService(deps));
}

const seriesNotFound = () => notFound("No series has that id.");

/**
 * Series endpoints: the series of a project, each following one format of the project, with
 * pause, resume and archive. Status changes publish the internal `series.updated` event, which
 * the calendar uses to replan.
 */
export function register(app: Hono<AppEnv>, deps: ModuleDeps): Hono<AppEnv> {
  const service = seriesServiceFor(deps);
  const router = new Hono<AppEnv>();
  const trustProxy = deps.config.trustProxy;

  router.get(routes["series.list"].path, async (c) => {
    currentUser(c);
    const query = ListSeriesQuerySchema.safeParse(c.req.query());
    if (!query.success) {
      throw validationFailed(issueDetails(query.error));
    }
    const items = await service.list(idParam(c, "projectId"), query.data);
    if (items === null) {
      throw notFound("Project not found.");
    }
    return c.json({ items }, 200);
  });

  router.post(routes["series.create"].path, async (c) => {
    const projectId = idParam(c, "projectId");
    const input = await readJson(c, CreateSeriesRequestSchema);
    const created = await service.create(projectId, input, userActor(c, trustProxy));
    return c.json(created, 201);
  });

  router.get(routes["series.get"].path, async (c) => {
    currentUser(c);
    const found = await service.get(idParam(c));
    if (found === null) {
      throw seriesNotFound();
    }
    return c.json(found, 200);
  });

  router.patch(routes["series.update"].path, async (c) => {
    const id = idParam(c);
    const input = await readJson(c, UpdateSeriesRequestSchema);
    const updated = await service.update(id, input, userActor(c, trustProxy));
    if (updated === null) {
      throw seriesNotFound();
    }
    return c.json(updated, 200);
  });

  function statusRoute(move: SeriesStatusMove) {
    return async (c: Context<AppEnv>) => {
      const updated = await service.setStatus(idParam(c), move, userActor(c, trustProxy));
      if (updated === null) {
        throw seriesNotFound();
      }
      return c.json(updated, 200);
    };
  }

  router.post(routes["series.pause"].path, statusRoute("pause"));
  router.post(routes["series.resume"].path, statusRoute("resume"));
  router.post(routes["series.archive"].path, statusRoute("archive"));

  app.route("/", router);
  return router;
}
