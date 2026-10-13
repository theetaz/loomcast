import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { type HttpMethod, routes } from "@loomcast/contracts";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { requestId } from "hono/request-id";
import { secureHeaders } from "hono/secure-headers";
import type { AppDeps, ModuleDeps, Presence, RegisterModule } from "./deps";
import { type Alert, createAlerts } from "./lib/alerts";
import { HttpError, notFound } from "./lib/errors";
import { type CheckStatus, createHealthRegistry, type HealthRegistry } from "./lib/health";
import {
  createS3Storage,
  createUnconfiguredStorage,
  presignedUrlOrigin,
  type Storage,
  type StorageConfig,
} from "./lib/storage";
import { createUnconfiguredVault, createVault, type TokenVault } from "./lib/vault";
import { register as registerApprovals } from "./modules/approvals";
import { createAssetsService, register as registerAssets } from "./modules/assets";
import { createAuthGuards, register as registerAuth } from "./modules/auth";
import { createSessionsService } from "./modules/auth/sessions";
import { register as registerBridge } from "./modules/bridge";
import { register as registerCadence } from "./modules/cadence";
import { register as registerCalendar } from "./modules/calendar";
import { register as registerChannels } from "./modules/channels";
import { register as registerContent } from "./modules/content";
import { register as registerConversations } from "./modules/conversations";
import { register as registerDevices } from "./modules/devices";
import { register as registerFormats } from "./modules/formats";
import { createJobsService, register as registerJobs } from "./modules/jobs";
import { createJobHooks, subscribeJobStatusHooks } from "./modules/jobs/handlers";
import { createKbService, register as registerKb } from "./modules/kb";
import { register as registerMcp } from "./modules/mcp";
import { register as registerOAuth } from "./modules/oauth";
import {
  databaseCheck,
  register as registerOps,
  schedulerCheck,
  storageCheck,
} from "./modules/ops";
import { register as registerProduction } from "./modules/production";
import { register as registerProjects } from "./modules/projects";
import { register as registerPublisher } from "./modules/publisher";
import { register as registerReviews } from "./modules/reviews";
import { createScheduler, register as registerScheduler } from "./modules/scheduler";
import { register as registerSeries } from "./modules/series";
import { register as registerSkills } from "./modules/skills";
import { register as registerStream } from "./modules/stream";
import { createTokensService, register as registerTokens } from "./modules/tokens";
import type { AppEnv } from "./types";

/** Largest request body accepted on `/api/*`. */
export const API_BODY_LIMIT_BYTES = 1024 * 1024;

/** Paths the web app never owns; the SPA fallback leaves them alone. */
const SERVER_PATH_RE = /^\/(api|mcp|bridge|healthz|readyz)(\/|$)/;

/** Requests logged at debug rather than info, to keep probes out of the logs. */
const QUIET_PATHS: ReadonlySet<string> = new Set(["/healthz", "/readyz"]);

const NO_DEVICES: ReadonlySet<string> = new Set();

interface PublicRoute {
  method: HttpMethod;
  pattern: RegExp;
}

function compilePath(path: string): RegExp {
  const source = path
    .split("/")
    .map((segment) =>
      segment.startsWith(":") ? "[^/]+" : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    )
    .join("/");
  return new RegExp(`^${source}$`);
}

/**
 * The only `/api/*` routes reachable without a session: those the contracts mark `auth: "none"`
 * (login and device pairing). Every other `/api/*` path, including unknown ones, needs a session.
 */
const PUBLIC_API_ROUTES: readonly PublicRoute[] = Object.values(routes)
  .filter((route) => route.auth === "none")
  .map((route) => ({ method: route.method, pattern: compilePath(route.path) }));

export function isPublicApiRoute(method: string, path: string): boolean {
  return PUBLIC_API_ROUTES.some((route) => route.method === method && route.pattern.test(path));
}

/**
 * Origins the browser fetches media from: presigned upload and download URLs on the S3 endpoint
 * (when storage is configured), and published renders under `PUBLIC_BASE_URL`. The CSP adds them
 * to `connect-src`, `img-src` and `media-src`.
 */
export function mediaOrigins(
  config: Pick<AppDeps["config"], "storage" | "publicBaseUrl">,
): string[] {
  const origins = [new URL(config.publicBaseUrl).origin];
  if (config.storage !== null) {
    origins.unshift(presignedUrlOrigin(config.storage));
  }
  return [...new Set(origins)];
}

export interface CreateAppOptions {
  /** Extra modules registered after the built-in ones. Tests use it to mount probe routes. */
  modules?: readonly RegisterModule[];
}

/**
 * Builds the HTTP app. All state comes from `deps`, so tests run it with `app.request()` against a
 * test database and a fake clock.
 */
export function createApp(deps: AppDeps, options: CreateAppOptions = {}): Hono<AppEnv> {
  const { config, logger } = deps;
  const sessions = createSessionsService(deps);
  const tokens = createTokensService(deps);
  const jobs = createJobsService(deps);
  const kb = createKbService({ ...deps, jobs });
  const hooks = createJobHooks(deps);
  deps.lifecycle.onClose(subscribeJobStatusHooks(deps.bus, hooks));
  const auth = createAuthGuards({ config, clock: deps.clock, sessions, tokens });
  const alert = alertSink(deps);
  const presence: Presence = { connectedDevices: () => NO_DEVICES };
  const storage: Storage =
    deps.storage ??
    (config.storage === null ? createUnconfiguredStorage() : ownStorage(deps, config.storage));
  const assets = createAssetsService({ ...deps, storage });
  const scheduler = createScheduler({
    db: deps.db,
    bus: deps.bus,
    clock: deps.clock,
    logger: logger.child({ module: "scheduler" }),
    config: config.scheduler,
    alert,
  });
  const health = readinessChecks(deps, scheduler);
  const vault: TokenVault =
    config.encryption === null ? createUnconfiguredVault() : createVault(config.encryption);
  const moduleDeps: ModuleDeps = {
    ...deps,
    alert,
    health,
    sessions,
    tokens,
    jobs,
    kb,
    hooks,
    auth,
    presence,
    storage,
    assets,
    scheduler,
    vault,
  };
  const media = mediaOrigins(config);

  const app = new Hono<AppEnv>();

  app.use(requestId());
  app.use(async (c, next) => {
    const started = performance.now();
    const log = logger.child({ requestId: c.get("requestId") });
    c.set("logger", log);
    await next();
    const status = c.res.status;
    const fields = {
      method: c.req.method,
      path: c.req.path,
      status,
      durationMs: Math.round(performance.now() - started),
      userId: c.get("user")?.id ?? c.get("token")?.user.id,
    };
    if (status >= 500) {
      log.error(fields, "request failed");
    } else if (QUIET_PATHS.has(c.req.path)) {
      log.debug(fields, "request");
    } else {
      log.info(fields, "request");
    }
  });
  app.use(
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        // The web app checksums uploads with WebAssembly (hash-wasm). `'wasm-unsafe-eval'` allows
        // compiling WebAssembly only; JavaScript `eval` stays blocked.
        scriptSrc: ["'self'", "'wasm-unsafe-eval'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "blob:", ...media],
        mediaSrc: ["'self'", "blob:", ...media],
        fontSrc: ["'self'", "data:"],
        connectSrc: ["'self'", ...media],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
    }),
  );
  app.use(
    "/api/*",
    bodyLimit({
      maxSize: API_BODY_LIMIT_BYTES,
      onError: (c) =>
        c.json(
          new HttpError(413, "payload_too_large", "The request body is too large.").toBody(),
          413,
        ),
    }),
  );

  // Default deny: every `/api/*` request needs a cookie session (and passes the CSRF check)
  // unless the contracts mark the route public. Public routes apply their own checks.
  app.use("/api/*", async (c, next) => {
    if (isPublicApiRoute(c.req.method, c.req.path)) {
      await next();
      return;
    }
    await auth.sessionGuard(c, next);
  });

  app.get("/healthz", (c) => c.json({ status: "ok" }));
  // Readiness: every registered check (database, object storage, scheduler and any a module
  // adds), each bounded to 2 s. Only statuses are public; the owner sees details on the ops status.
  app.get("/readyz", async (c) => {
    c.header("Cache-Control", "no-store");
    if (deps.lifecycle.closing) {
      const skipped = Object.fromEntries(health.names().map((name) => [name, "skipped"]));
      return c.json({ status: "unavailable", checks: skipped }, 503);
    }
    const report = await health.run();
    const checks: Record<string, CheckStatus> = {};
    const failures: Record<string, string> = {};
    for (const [name, result] of Object.entries(report.checks)) {
      checks[name] = result.status;
      if (result.status === "error") {
        failures[name] = result.detail ?? "failed";
      }
    }
    if (!report.ok) {
      c.get("logger").warn({ checks: failures }, "readiness check failed");
    }
    return c.json({ status: report.ok ? "ok" : "unavailable", checks }, report.ok ? 200 : 503);
  });

  registerAuth(app, moduleDeps);
  registerTokens(app, moduleDeps);
  registerProjects(app, moduleDeps);
  registerConversations(app, moduleDeps);
  registerKb(app, moduleDeps);
  registerAssets(app, moduleDeps);
  registerFormats(app, moduleDeps);
  registerSeries(app, moduleDeps);
  registerContent(app, moduleDeps);
  registerReviews(app, moduleDeps);
  registerProduction(app, moduleDeps);
  registerSkills(app, moduleDeps);
  registerChannels(app, moduleDeps);
  registerOAuth(app, moduleDeps);
  registerCalendar(app, moduleDeps);
  registerCadence(app, moduleDeps);
  registerApprovals(app, moduleDeps);
  registerPublisher(app, moduleDeps);
  registerScheduler(app, moduleDeps);
  registerStream(app, moduleDeps);
  registerDevices(app, moduleDeps);
  registerBridge(app, moduleDeps);
  registerJobs(app, moduleDeps);
  registerMcp(app, moduleDeps);
  registerOps(app, moduleDeps);
  for (const register of options.modules ?? []) {
    register(app, moduleDeps);
  }

  // Background work runs only in a served process, after every module registered its handlers.
  if (deps.httpServer !== undefined && config.scheduler.enabled) {
    scheduler.start();
    deps.lifecycle.onClose(() => scheduler.stop());
  }

  if (config.isProduction && config.webDistDir !== null) {
    serveWebApp(app, config.webDistDir);
  }

  app.notFound((c) => c.json(notFound().toBody(), 404));
  app.onError((error, c) => errorResponse(error, c, deps));

  return app;
}

/**
 * Where alerts go: `AppDeps.alert` when a caller supplies one (tests), otherwise the webhook alerts
 * from `ALERT_WEBHOOK_URL`, de-duplicated per key. The returned function never throws.
 */
function alertSink(deps: AppDeps): (alert: Alert) => Promise<void> {
  const logger = deps.logger.child({ module: "alerts" });
  const alerts = createAlerts({ config: deps.config.alerts, clock: deps.clock, logger });
  return async (alert) => {
    try {
      if (deps.alert === undefined) {
        await alerts.send(alert);
      } else {
        await deps.alert(alert);
      }
    } catch (error) {
      logger.error({ err: error, alert: alert.key }, "could not raise an alert");
    }
  };
}

/** The readiness registry with the database, object storage and scheduler checks. */
function readinessChecks(deps: AppDeps, scheduler: ModuleDeps["scheduler"]): HealthRegistry {
  const health = createHealthRegistry();
  health.register("database", databaseCheck(deps.db));
  const storage = storageCheck(deps.config.storage, deps.clock);
  deps.lifecycle.onClose(() => storage.destroy());
  health.register("storage", storage.check);
  health.register("scheduler", schedulerCheck(scheduler));
  return health;
}

/** The S3 client for `config.storage`, closed with the app. */
function ownStorage(deps: AppDeps, config: StorageConfig): Storage {
  const storage = createS3Storage(config);
  deps.lifecycle.onClose(() => storage.destroy());
  return storage;
}

function errorResponse(error: Error, c: Context<AppEnv>, deps: AppDeps): Response {
  const log = c.get("logger") ?? deps.logger;
  if (error instanceof HttpError) {
    for (const [name, value] of Object.entries(error.headers ?? {})) {
      c.header(name, value);
    }
    return c.json(error.toBody(), error.status);
  }
  if (error instanceof HTTPException && error.status < 500) {
    const known = new HttpError(error.status, "bad_request", error.message || "Bad request.");
    return c.json(known.toBody(), error.status);
  }
  log.error({ err: error }, "unhandled error");
  return c.json(new HttpError(500, "internal", "Something went wrong on our side.").toBody(), 500);
}

/**
 * Serves the built web app. Hashed files under `/assets` are cached for a year; everything else
 * revalidates. Unknown paths without a file extension get `index.html`, so client routes load.
 */
function serveWebApp(app: Hono<AppEnv>, root: string): void {
  let indexHtml: Promise<string> | null = null;
  const serveFile = serveStatic<AppEnv>({ root });

  app.use("*", async (c, next) => {
    if (SERVER_PATH_RE.test(c.req.path) || (c.req.method !== "GET" && c.req.method !== "HEAD")) {
      await next();
      return;
    }
    const response = await serveFile(c, next);
    if (response instanceof Response) {
      response.headers.set(
        "Cache-Control",
        c.req.path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
      );
    }
    return response;
  });

  app.get("*", async (c, next) => {
    const lastSegment = c.req.path.split("/").at(-1) ?? "";
    if (SERVER_PATH_RE.test(c.req.path) || lastSegment.includes(".")) {
      await next();
      return;
    }
    indexHtml ??= readFile(join(root, "index.html"), "utf8");
    try {
      const html = await indexHtml;
      c.header("Cache-Control", "no-cache");
      return c.html(html);
    } catch (error) {
      indexHtml = null;
      throw error;
    }
  });
}
