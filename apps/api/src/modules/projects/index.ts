import { Hono } from "hono";
import type { ModuleDeps } from "../../deps";
import type { AppEnv } from "../../types";

/**
 * Project endpoints and the projects service. Not implemented yet: the router is
 * mounted empty so `createApp` already registers the module.
 */
export function register(app: Hono<AppEnv>, _deps: ModuleDeps): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  app.route("/", router);
  return router;
}
