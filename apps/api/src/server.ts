import { realpathSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { type ServerType, serve } from "@hono/node-server";
import { createDb } from "@loomcast/db";
import type { Hono } from "hono";
import { type CreateAppOptions, createApp } from "./app";
import type { AppDeps } from "./deps";
import { type Config, loadConfig } from "./env";
import { createEventBus } from "./lib/bus";
import { systemClock } from "./lib/clock";
import { createLifecycle } from "./lib/lifecycle";
import { createLogger, type Logger } from "./lib/logger";
import type { AppEnv } from "./types";

/** How long open requests may finish after SIGTERM before their sockets are closed. */
export const DRAIN_TIMEOUT_MS = 10_000;

/** After this long, shutdown gives up waiting and the process exits with an error. */
const SHUTDOWN_DEADLINE_MS = 20_000;

export interface RunningServer {
  app: Hono<AppEnv>;
  server: ServerType;
  /** The bound port; useful with `port: 0`. */
  port: number;
  /**
   * Graceful shutdown: stop accepting connections, run the lifecycle hooks (bridge sockets, event
   * streams), let in-flight requests drain for up to `drainTimeoutMs`, then close what is left.
   */
  close(drainTimeoutMs?: number): Promise<void>;
}

/**
 * Serves `createApp(deps)` on `port` and `host`. `deps.httpServer` is set before the app is
 * built, so modules can attach to the server (the bridge listens for `upgrade`). No request can
 * arrive before the app exists: listening starts asynchronously, after this function returns.
 */
export async function startServer(
  deps: AppDeps,
  options: { port: number; host: string } & CreateAppOptions,
): Promise<RunningServer> {
  let app: Hono<AppEnv> | undefined;
  let resolveListening: (info: AddressInfo) => void = () => {};
  const listening = new Promise<AddressInfo>((resolve) => {
    resolveListening = resolve;
  });

  const server = serve(
    {
      fetch: (request, env) => {
        if (app === undefined) {
          return new Response(null, { status: 503 });
        }
        return app.fetch(request, env);
      },
      port: options.port,
      hostname: options.host,
    },
    (info) => resolveListening(info),
  );
  deps.httpServer = server;
  app = createApp(deps, { modules: options.modules });

  const info = await listening;
  let closing: Promise<void> | null = null;

  return {
    app,
    server,
    port: info.port,
    close(drainTimeoutMs = DRAIN_TIMEOUT_MS) {
      closing ??= (async () => {
        const http = server as Server;
        const closed = new Promise<void>((resolve) => http.close(() => resolve()));
        http.closeIdleConnections();
        await deps.lifecycle.close();
        const timer = setTimeout(() => http.closeAllConnections(), drainTimeoutMs);
        timer.unref();
        await closed;
        clearTimeout(timer);
      })();
      return closing;
    },
  };
}

/** Process entry: loads the config, starts the server and installs the shutdown handlers. */
export async function main(): Promise<void> {
  let config: Config;
  try {
    config = loadConfig();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
    return;
  }

  const logger: Logger = createLogger({ level: config.logLevel });
  const database = createDb(config.databaseUrl, { max: 10 });
  const lifecycle = createLifecycle(logger);
  const deps: AppDeps = {
    db: database.db,
    bus: createEventBus(logger),
    clock: systemClock,
    logger,
    config,
    lifecycle,
  };

  const running = await startServer(deps, { port: config.port, host: config.host });
  logger.info(
    { port: running.port, host: config.host, env: config.nodeEnv },
    `api listening on http://${config.host}:${running.port}`,
  );

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info({ signal }, "shutting down");
    const deadline = setTimeout(() => {
      logger.error("shutdown deadline passed; exiting");
      process.exit(1);
    }, SHUTDOWN_DEADLINE_MS);
    deadline.unref();
    running
      .close()
      .then(() => database.close())
      .then(
        () => {
          logger.info("shutdown complete");
          process.exitCode = 0;
        },
        (error: unknown) => {
          logger.error({ err: error }, "shutdown failed");
          process.exitCode = 1;
        },
      );
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && realpathSync(entry) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  main().catch((error: unknown) => {
    console.error("api failed to start:", error);
    process.exitCode = 1;
  });
}
