import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { type HttpMethod, routes } from "@loomcast/contracts";
import { sql } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { requestId } from "hono/request-id";
import { secureHeaders } from "hono/secure-headers";
import type { AppDeps, ModuleDeps, Presence, RegisterModule } from "./deps";
import { HttpError, notFound } from "./lib/errors";
import {
  createS3Storage,
  createUnconfiguredStorage,
  type Storage,
  type StorageConfig,
} from "./lib/storage";
import { createAssetsService, register as registerAssets } from "./modules/assets";
import { createAuthGuards, register as registerAuth } from "./modules/auth";
import { createSessionsService } from "./modules/auth/sessions";
import { register as registerBridge } from "./modules/bridge";
import { register as registerConversations } from "./modules/conversations";
import { register as registerDevices } from "./modules/devices";
import { createJobsService, register as registerJobs } from "./modules/jobs";
import { createJobHooks, subscribeJobStatusHooks } from "./modules/jobs/handlers";
import { createKbService, register as registerKb } from "./modules/kb";
import { register as registerMcp } from "./modules/mcp";
import { register as registerProjects } from "./modules/projects";
import { register as registerStream } from "./modules/stream";
import { createTokensService, register as registerTokens } from "./modules/tokens";
import type { AppEnv } from "./types";

/** Largest request body accepted on `/api/*`. */
export const API_BODY_LIMIT_BYTES = 1024 * 1024;

const READY_TIMEOUT_MS = 2_000;

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
  const presence: Presence = { connectedDevices: () => NO_DEVICES };
  const storage: Storage =
    deps.storage ??
    (config.storage === null ? createUnconfiguredStorage() : ownStorage(deps, config.storage));
  const assets = createAssetsService({ ...deps, storage });
  const moduleDeps: ModuleDeps = {
    ...deps,
    sessions,
    tokens,
    jobs,
    kb,
    hooks,
    auth,
    presence,
    storage,
    assets,
  };

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
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "blob:"],
        fontSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
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
  app.get("/readyz", async (c) => {
    if (deps.lifecycle.closing) {
      return c.json({ status: "unavailable", checks: { database: "skipped" } }, 503);
    }
    try {
      await withTimeout(deps.db.execute(sql`select 1`), READY_TIMEOUT_MS);
      return c.json({ status: "ok", checks: { database: "ok" } });
    } catch (error) {
      c.get("logger").warn({ err: error }, "readiness check failed");
      return c.json({ status: "unavailable", checks: { database: "error" } }, 503);
    }
  });

  registerAuth(app, moduleDeps);
  registerTokens(app, moduleDeps);
  registerProjects(app, moduleDeps);
  registerConversations(app, moduleDeps);
  registerKb(app, moduleDeps);
  registerAssets(app, moduleDeps);
  registerStream(app, moduleDeps);
  registerDevices(app, moduleDeps);
  registerBridge(app, moduleDeps);
  registerJobs(app, moduleDeps);
  registerMcp(app, moduleDeps);
  for (const register of options.modules ?? []) {
    register(app, moduleDeps);
  }

  if (config.isProduction && config.webDistDir !== null) {
    serveWebApp(app, config.webDistDir);
  }

  app.notFound((c) => c.json(notFound().toBody(), 404));
  app.onError((error, c) => errorResponse(error, c, deps));

  return app;
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

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
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
