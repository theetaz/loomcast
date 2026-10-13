import {
  AnalyticsOverviewQuerySchema,
  routes,
  SeriesAnalyticsQuerySchema,
} from "@loomcast/contracts";
import { Hono } from "hono";
import type { z } from "zod";
import type { ModuleDeps } from "../../deps";
import { notFound, validationFailed } from "../../lib/errors";
import { idParam, issueDetails } from "../../lib/http";
import type { AppEnv } from "../../types";
import { currentUser } from "../auth/guards";
import { createAnalyticsService } from "./service";

export { toMetricCounts, toPostMetrics } from "./mappers";
export {
  type AnalyticsService,
  createAnalyticsService,
  nextCaptureAt,
  overviewOf,
} from "./service";

function parseQuery<S extends z.ZodType>(schema: S, query: Record<string, string>): z.output<S> {
  const parsed = schema.safeParse(query);
  if (!parsed.success) {
    throw validationFailed(issueDetails(parsed.error));
  }
  return parsed.data;
}

/**
 * Analytics: the post, item, series and overview figures of live posts (published, not dry-run),
 * computed from each post's latest capture with `aggregatePosts`.
 */
export function register(app: Hono<AppEnv>, deps: ModuleDeps): Hono<AppEnv> {
  const service = createAnalyticsService(deps.db);
  const router = new Hono<AppEnv>();

  router.get(routes["analytics.overview"].path, async (c) => {
    currentUser(c);
    const query = parseQuery(AnalyticsOverviewQuerySchema, c.req.query());
    c.header("Cache-Control", "no-store");
    return c.json(await service.overview(query), 200);
  });

  router.get(routes["analytics.post"].path, async (c) => {
    currentUser(c);
    const found = await service.post(idParam(c));
    if (found === null) {
      throw notFound("No live post has that id.");
    }
    c.header("Cache-Control", "no-store");
    return c.json(found, 200);
  });

  router.get(routes["analytics.item"].path, async (c) => {
    currentUser(c);
    const found = await service.item(idParam(c));
    if (found === null) {
      throw notFound("No content item has that id.");
    }
    c.header("Cache-Control", "no-store");
    return c.json(found, 200);
  });

  router.get(routes["analytics.series"].path, async (c) => {
    currentUser(c);
    const id = idParam(c);
    const query = parseQuery(SeriesAnalyticsQuerySchema, c.req.query());
    const found = await service.series(id, query);
    if (found === null) {
      throw notFound("No series has that id.");
    }
    c.header("Cache-Control", "no-store");
    return c.json(found, 200);
  });

  app.route("/", router);
  return router;
}
