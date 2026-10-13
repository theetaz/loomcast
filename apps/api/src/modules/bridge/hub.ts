import type { IncomingMessage, Server } from "node:http";
import { STATUS_CODES } from "node:http";
import type { Duplex } from "node:stream";
import {
  BRIDGE_LIMITS,
  BRIDGE_PATH,
  BRIDGE_TIMINGS,
  CLOSE_CODES,
  type JobStatus,
} from "@loomcast/contracts";
import { devices } from "@loomcast/db";
import { eq } from "drizzle-orm";
import { WebSocketServer } from "ws";
import type { ModuleDeps } from "../../deps";
import type { Unsubscribe } from "../../lib/bus";
import { createDispatcher, type Dispatcher } from "../jobs/dispatcher";
import { createJobLifecycle, type JobLifecycle, type SweptJob } from "../jobs/lifecycle";
import { createReaper, REAPER_INTERVAL_MS, type Reaper } from "../jobs/reaper";
import { BridgeSession } from "./session";

/** How often the dispatcher runs without a trigger, and re-queues unaccepted jobs. */
export const DISPATCH_INTERVAL_MS = 5_000;

/** Longest a closing hub waits for connections to finish handling their messages. */
const DRAIN_TIMEOUT_MS = 5_000;

const CLOSE_GOING_AWAY = 1001;

export interface BridgeHubOptions {
  /** Server ping interval (`hello.ok.heartbeatMs`). */
  pingIntervalMs?: number;
  /** Job lease and disconnect grace period. */
  leaseMs?: number;
  /** A dispatched job not accepted within this time goes back to the queue. */
  acceptTimeoutMs?: number;
  /** Safety-net dispatch tick and unaccepted-job sweep. 0 disables the timer. */
  dispatchIntervalMs?: number;
  /** Lease sweep. 0 disables the timer. */
  reaperIntervalMs?: number;
}

export interface BridgeHub {
  /** Devices with a live connection that has completed `hello`. */
  connectedDevices(): ReadonlySet<string>;
  readonly lifecycle: JobLifecycle;
  readonly dispatcher: Dispatcher;
  readonly reaper: Reaper;
  /**
   * One safety-net pass: re-queues jobs not accepted within the accept timeout, applies expired
   * leases, stops those jobs on their previous agent and runs a dispatch round.
   */
  sweep(): Promise<SweptJob[]>;
  /** Closes every connection (1001), stops the timers and detaches from the HTTP server. */
  close(): Promise<void>;
}

type UpgradeAuth = { ok: true; deviceId: string } | { ok: false; status: 401 | 403 | 503 };

const BEARER_RE = /^Bearer[ \t]+([^\s]+)[ \t]*$/i;

const ACTIVE_STATUSES: ReadonlySet<JobStatus> = new Set(["dispatched", "running"]);

/**
 * The `/bridge/v1` WebSocket hub. It authenticates the upgrade with the device token (no socket is
 * opened for a bad token, a revoked device or a browser `Origin`), keeps one connection per device
 * (a newer one supersedes the older with 4409), pings every connection and terminates one that
 * misses two pongs, closes a revoked device with 4403, and drives the dispatcher and the reaper.
 */
export function createBridgeHub(deps: ModuleDeps, options: BridgeHubOptions = {}): BridgeHub {
  const { db, bus, clock, logger, tokens } = deps;
  if (deps.httpServer === undefined) {
    throw new Error("the bridge hub needs the HTTP server");
  }
  const server = deps.httpServer as Server;
  const log = logger.child({ module: "bridge" });
  const timings = {
    heartbeatMs: options.pingIntervalMs ?? BRIDGE_TIMINGS.serverPingMs,
    leaseMs: options.leaseMs ?? BRIDGE_TIMINGS.leaseMs,
  };
  const acceptTimeoutMs = options.acceptTimeoutMs ?? BRIDGE_TIMINGS.acceptTimeoutMs;

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: BRIDGE_LIMITS.maxPayloadBytes,
    perMessageDeflate: false,
  });
  /** The newest connection of each device. */
  const current = new Map<string, BridgeSession>();
  /** Every open connection, including superseded ones still closing. */
  const sessions = new Set<BridgeSession>();
  /** Devices whose connection completed `hello`. */
  const online = new Set<string>();
  /** Disconnects still being recorded. */
  const detaching = new Set<Promise<void>>();
  let closed = false;

  const lifecycle = createJobLifecycle(deps);
  const dispatcher = createDispatcher({
    db,
    bus,
    clock,
    logger: log,
    lifecycle,
    sessions: () => [...current.values()].filter((session) => session.ready),
    leaseMs: timings.leaseMs,
    tokens,
  });
  const reaper = createReaper({
    lifecycle,
    logger: log,
    intervalMs: options.reaperIntervalMs ?? REAPER_INTERVAL_MS,
    onSwept: (swept) => afterSweep(swept),
  });

  /** Jobs that left their agent on the server side: forget them there and stop them. */
  function afterSweep(swept: readonly SweptJob[], stop = true): void {
    for (const { job, previousDevice } of swept) {
      const session = previousDevice === null ? undefined : current.get(previousDevice);
      if (session === undefined) {
        continue;
      }
      session.forget(job.id);
      if (stop && !ACTIVE_STATUSES.has(job.status)) {
        session.cancel(job.id);
      }
    }
    if (swept.length > 0) {
      dispatcher.trigger();
    }
  }

  async function sweepUnaccepted(): Promise<SweptJob[]> {
    const before = new Date(clock.now().getTime() - acceptTimeoutMs);
    const swept = await lifecycle.requeueUnaccepted(before);
    for (const { job, previousDevice } of swept) {
      log.info({ jobId: job.id, deviceId: previousDevice }, "job not accepted in time; re-queued");
    }
    // An agent that never saw the assignment would never answer a cancel; a late accept is
    // answered with `job.cancel` instead.
    afterSweep(swept, false);
    return swept;
  }

  // ---------------------------------------------------------------- upgrade

  async function authenticate(request: IncomingMessage): Promise<UpgradeAuth> {
    if (request.headers.origin !== undefined) {
      // Browsers always send Origin; the studio agent never does. This blocks cross-site
      // WebSocket hijacking.
      return { ok: false, status: 403 };
    }
    const match = BEARER_RE.exec(request.headers.authorization ?? "");
    const raw = match?.[1];
    if (raw === undefined) {
      return { ok: false, status: 401 };
    }
    const token = await tokens.verify(raw, "device");
    if (token === null || !token.scopes.includes("bridge")) {
      return { ok: false, status: 401 };
    }
    const [device] = await db
      .select({ id: devices.id, revokedAt: devices.revokedAt })
      .from(devices)
      .where(eq(devices.tokenId, token.id))
      .limit(1);
    if (device === undefined) {
      return { ok: false, status: 401 };
    }
    if (device.revokedAt !== null) {
      return { ok: false, status: 403 };
    }
    return closed ? { ok: false, status: 503 } : { ok: true, deviceId: device.id };
  }

  function refuse(socket: Duplex, status: number): void {
    if (!socket.destroyed) {
      socket.end(
        `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? ""}\r\n` +
          "Connection: close\r\nContent-Length: 0\r\n\r\n",
      );
      socket.destroy();
    }
  }

  function onUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const path = (request.url ?? "").split("?")[0];
    if (path !== BRIDGE_PATH) {
      // Leave other paths to other upgrade listeners; refuse them when there are none.
      if (server.listenerCount("upgrade") === 1) {
        refuse(socket, 404);
      }
      return;
    }
    socket.on("error", (error) => log.debug({ err: error }, "bridge upgrade socket error"));
    if (closed) {
      refuse(socket, 503);
      return;
    }
    authenticate(request).then(
      (auth) => {
        if (!auth.ok) {
          log.info({ status: auth.status }, "bridge connection refused");
          refuse(socket, auth.status);
          return;
        }
        if (socket.destroyed) {
          return;
        }
        wss.handleUpgrade(request, socket, head, (ws) => attach(ws, auth.deviceId));
      },
      (error: unknown) => {
        log.error({ err: error }, "bridge authentication failed");
        refuse(socket, 503);
      },
    );
  }

  // ---------------------------------------------------------------- connections

  function attach(ws: import("ws").WebSocket, deviceId: string): void {
    if (closed) {
      ws.close(CLOSE_GOING_AWAY, "server shutting down");
      return;
    }
    const previous = current.get(deviceId);
    const session = new BridgeSession(ws, deviceId, {
      db,
      bus,
      logger: log,
      lifecycle,
      dispatcher,
      timings,
      previous: () => previous?.drained() ?? Promise.resolve(),
      ready: (ready, hello) => markOnline(ready, hello),
    });
    current.set(deviceId, session);
    sessions.add(session);
    if (previous !== undefined) {
      log.info({ deviceId }, "a newer connection supersedes this device's connection");
      previous.close(CLOSE_CODES.superseded, "superseded by a newer connection");
    }
    ws.on("close", () => {
      const detached = detach(session).catch((error: unknown) =>
        log.error({ err: error, deviceId }, "could not record the disconnect"),
      );
      detaching.add(detached);
      void detached.finally(() => detaching.delete(detached));
    });
  }

  async function markOnline(
    session: BridgeSession,
    hello: { agentVersion: string; platform: string },
  ): Promise<void> {
    if (current.get(session.deviceId) !== session) {
      return;
    }
    const now = clock.now();
    await db
      .update(devices)
      .set({ lastSeenAt: now, agentVersion: hello.agentVersion, platform: hello.platform })
      .where(eq(devices.id, session.deviceId));
    online.add(session.deviceId);
    bus.publish({
      type: "device.status",
      payload: { deviceId: session.deviceId, online: true, lastSeenAt: now.toISOString() },
    });
  }

  async function detach(session: BridgeSession): Promise<void> {
    session.closed();
    sessions.delete(session);
    if (current.get(session.deviceId) !== session) {
      return;
    }
    current.delete(session.deviceId);
    if (!online.delete(session.deviceId)) {
      return;
    }
    const now = clock.now();
    await db.update(devices).set({ lastSeenAt: now }).where(eq(devices.id, session.deviceId));
    if (session.closeCode !== CLOSE_CODES.revoked) {
      // The devices module publishes the offline status of a revoked device itself.
      bus.publish({
        type: "device.status",
        payload: { deviceId: session.deviceId, online: false, lastSeenAt: now.toISOString() },
      });
    }
  }

  // ---------------------------------------------------------------- wiring

  server.on("upgrade", onUpgrade);

  const unsubscribe: Unsubscribe[] = [
    bus.subscribe("job.enqueued", () => dispatcher.trigger()),
    bus.subscribe("device.revoked", (event) => {
      const session = current.get(event.payload.deviceId);
      if (session !== undefined) {
        log.info({ deviceId: event.payload.deviceId }, "device revoked; closing its connection");
        session.close(CLOSE_CODES.revoked, "device revoked", true);
      }
    }),
    bus.subscribe("job.updated", (event) => {
      const { job } = event.payload;
      if (
        job.cancelRequestedAt !== null &&
        job.claimedByDevice !== null &&
        ACTIVE_STATUSES.has(job.status)
      ) {
        current.get(job.claimedByDevice)?.cancel(job.id);
      }
    }),
  ];

  const pingTimer = setInterval(() => {
    for (const session of sessions) {
      session.ping();
    }
  }, timings.heartbeatMs);
  pingTimer.unref();

  const dispatchIntervalMs = options.dispatchIntervalMs ?? DISPATCH_INTERVAL_MS;
  let ticking = false;
  const dispatchTimer =
    dispatchIntervalMs > 0
      ? setInterval(() => {
          if (ticking) {
            return;
          }
          ticking = true;
          sweepUnaccepted()
            .then(() => dispatcher.run())
            .catch((error: unknown) => log.error({ err: error }, "dispatch tick failed"))
            .finally(() => {
              ticking = false;
            });
        }, dispatchIntervalMs)
      : null;
  dispatchTimer?.unref();
  reaper.start();

  let closing: Promise<void> | null = null;

  return {
    connectedDevices: () => new Set(online),
    lifecycle,
    dispatcher,
    reaper,
    async sweep() {
      const unaccepted = await sweepUnaccepted();
      const expired = await reaper.sweep();
      await dispatcher.run();
      return [...unaccepted, ...expired];
    },
    close() {
      closing ??= (async () => {
        closed = true;
        server.off("upgrade", onUpgrade);
        for (const stop of unsubscribe) {
          stop();
        }
        clearInterval(pingTimer);
        if (dispatchTimer !== null) {
          clearInterval(dispatchTimer);
        }
        reaper.stop();
        const open = [...sessions];
        for (const session of open) {
          session.close(CLOSE_GOING_AWAY, "server shutting down");
        }
        const drained = Promise.all(open.map((session) => session.drained()));
        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<void>((resolve) => {
          timer = setTimeout(resolve, DRAIN_TIMEOUT_MS);
          timer.unref();
        });
        await Promise.race([drained.then(() => dispatcher.idle()), timeout]);
        clearTimeout(timer);
        // Agents that did not answer the close frame in time are dropped.
        for (const session of sessions) {
          session.terminate();
        }
        await new Promise<void>((resolve) => wss.close(() => resolve()));
        await Promise.all([...detaching]);
      })();
      return closing;
    },
  };
}
