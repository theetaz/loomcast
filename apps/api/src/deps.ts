import type { ServerType } from "@hono/node-server";
import type { Database } from "@loomcast/db";
import type { Hono } from "hono";
import type { Config } from "./env";
import type { EventBus } from "./lib/bus";
import type { Clock } from "./lib/clock";
import type { HealthRegistry } from "./lib/health";
import type { Lifecycle } from "./lib/lifecycle";
import type { Logger } from "./lib/logger";
import type { Storage } from "./lib/storage";
import type { TokenVault } from "./lib/vault";
import type { AssetsService } from "./modules/assets/service";
import type { AuthGuards } from "./modules/auth/guards";
import type { SessionsService } from "./modules/auth/sessions";
import type { JobHooks } from "./modules/jobs/hooks";
import type { JobsService } from "./modules/jobs/service";
import type { KbService } from "./modules/kb/service";
import type { Scheduler, SchedulerAlert } from "./modules/scheduler/scheduler";
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
  /**
   * Object storage. When absent, `createApp` builds the S3 client from `config.storage`; tests
   * may pass their own.
   */
  storage?: Storage;
  /**
   * Receives scheduler alerts (dead and failed tasks). Without it they are logged at error level.
   * The ops module wires the webhook alerts here.
   */
  alert?: (alert: SchedulerAlert) => void | Promise<void>;
}

/** Which studio agents have a live bridge connection. The bridge module replaces the default. */
export interface Presence {
  connectedDevices(): ReadonlySet<string>;
}

/** What every module's `register` receives: the app deps plus the shared services and guards. */
export interface ModuleDeps extends AppDeps {
  /**
   * Readiness checks behind `/readyz` (database, object storage, scheduler). A module that owns
   * another dependency registers its check here in `register`.
   */
  health: HealthRegistry;
  sessions: SessionsService;
  tokens: TokensService;
  jobs: JobsService;
  /** Knowledge-base entries, shared by the REST routes and the MCP tools. */
  kb: KbService;
  /**
   * The job-type hook registry (`createJobHooks` in `modules/jobs/handlers`). Every
   * `createJobLifecycle(deps)` runs these instead of its built-in default.
   */
  hooks: JobHooks;
  auth: AuthGuards;
  presence: Presence;
  /** Object storage: presigned URLs, verification reads and `promoteToPublic` for the publisher. */
  storage: Storage;
  /** Uploads, verification and downloads of stored files, shared by REST and the MCP tools. */
  assets: AssetsService;
  /**
   * Server-side scheduled tasks. Modules register a handler per task kind in `register` and
   * enqueue tasks (optionally in a transaction). The loop runs only under `startServer`.
   */
  scheduler: Scheduler;
  /**
   * AES-256-GCM encryption of channel credentials (`encrypt(value, channelAad(id))`). When the
   * server has no `LOOMCAST_ENCRYPTION_KEY` (outside production) every call answers 503.
   */
  vault: TokenVault;
}

/**
 * A module adds its routes to a router of its own, mounts it on `app` and returns it. Routes must be
 * added before the router is mounted, because Hono copies routes when `app.route` is called.
 */
export type RegisterModule = (app: Hono<AppEnv>, deps: ModuleDeps) => Hono<AppEnv>;
