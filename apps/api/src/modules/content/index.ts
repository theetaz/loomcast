import { Hono } from "hono";
import type { ModuleDeps } from "../../deps";
import type { AppEnv } from "../../types";

/**
 * Content item endpoints: items, immutable versions and pipeline transitions (M3-04).
 * The item's asset list (`GET /api/content/:id/assets`) is served by the assets module.
 * Not implemented yet: the router is mounted empty so `createApp` already registers the module.
 */
export function register(app: Hono<AppEnv>, _deps: ModuleDeps): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  app.route("/", router);
  return router;
}
