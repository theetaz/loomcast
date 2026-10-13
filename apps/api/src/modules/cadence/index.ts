import { Hono } from "hono";
import type { ModuleDeps } from "../../deps";
import type { AppEnv } from "../../types";

/**
 * Cadence planning: the `cadence.plan` and `cadence.produce` task handlers that turn series
 * cadences into items and planned posts (M4-04).
 * Not implemented yet: the router is mounted empty so `createApp` already registers the module.
 */
export function register(app: Hono<AppEnv>, _deps: ModuleDeps): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  app.route("/", router);
  return router;
}
