import { Hono } from "hono";
import type { ModuleDeps } from "../../deps";
import type { AppEnv } from "../../types";

/**
 * Production endpoints: content actions that start production jobs and turn their
 * results into versions (M3-05).
 * Not implemented yet: the router is mounted empty so `createApp` already registers the module.
 */
export function register(app: Hono<AppEnv>, _deps: ModuleDeps): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  app.route("/", router);
  return router;
}
