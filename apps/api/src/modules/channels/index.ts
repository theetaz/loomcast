import { Hono } from "hono";
import type { ModuleDeps } from "../../deps";
import type { AppEnv } from "../../types";

/**
 * Channel endpoints: list, create and update channels, series links and the dry-run switch (M4-05);
 * OAuth connections land in M5-03.
 * Not implemented yet: the router is mounted empty so `createApp` already registers the module.
 */
export function register(app: Hono<AppEnv>, _deps: ModuleDeps): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  app.route("/", router);
  return router;
}
