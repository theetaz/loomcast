import type { ServerType } from "@hono/node-server";
import type { Database } from "@loomcast/db";
import type { Hono } from "hono";
import type { Config } from "./env";
import type { EventBus } from "./lib/bus";
import type { Clock } from "./lib/clock";
import type { Lifecycle } from "./lib/lifecycle";
import type { Logger } from "./lib/logger";
import type { AuthGuards } from "./modules/auth/guards";
import type { SessionsService } from "./modules/auth/sessions";
import type { JobsService } from "./modules/jobs/service";
import type { KbService } from "./modules/kb/service";
import type { TokensService } from "./modules/tokens/service";
import type { AppEnv } from "./types";

/** What `createApp` needs from outside. Tests build their own with a test database and clock. */
export interface AppDeps {
  db: Database;
  bus: EventBus;
  clock: Clock;
  logger: Logger;
  config: Config;
  lifecycle: Lifecycle;
  /**
   * The Node HTTP server, when the app is served by `startServer`. The bridge module attaches its
   * WebSocket `upgrade` handler to it. Absent under `app.request()` in tests.
   */
  httpServer?: ServerType;
}

/** Which studio agents have a live bridge connection. The bridge module replaces the default. */
export interface Presence {
  connectedDevices(): ReadonlySet<string>;
}

/** What every module's `register` receives: the app deps plus the shared services and guards. */
export interface ModuleDeps extends AppDeps {
  sessions: SessionsService;
  tokens: TokensService;
  jobs: JobsService;
  /** Knowledge-base entries, shared by the REST routes and the MCP tools. */
  kb: KbService;
  auth: AuthGuards;
  presence: Presence;
}

/**
 * A module adds its routes to a router of its own, mounts it on `app` and returns it. Routes must be
 * added before the router is mounted, because Hono copies routes when `app.route` is called.
 */
export type RegisterModule = (app: Hono<AppEnv>, deps: ModuleDeps) => Hono<AppEnv>;
