import { Hono } from "hono";
import type { ModuleDeps } from "../../deps";
import type { AppEnv } from "../../types";

/**
 * The `/bridge/v1` WebSocket hub, attached to `deps.httpServer`. Not implemented yet: the router is
 * mounted empty so `createApp` already registers the module.
 */
export function register(app: Hono<AppEnv>, _deps: ModuleDeps): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  app.route("/", router);
  return router;
}
