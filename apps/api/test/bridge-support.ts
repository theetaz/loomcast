import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import {
  type AgentToServerDraft,
  BRIDGE_PATH,
  type Credits,
  encode,
  type JobType,
  PROTOCOL_VERSION,
  parseServerMessage,
  type ResumeEntry,
  type ServerMessageOf,
  type ServerToAgent,
  type ServerToAgentType,
} from "@loomcast/contracts";
import { conversations, type Database, devices, workspaces } from "@loomcast/db";
import type { Hono } from "hono";
import { vi } from "vitest";
import WebSocket from "ws";
import { createApp } from "../src/app";
import type { AppDeps, ModuleDeps } from "../src/deps";
import { type BusEvent, type BusEventType, createEventBus, type EventBus } from "../src/lib/bus";
import { createLifecycle } from "../src/lib/lifecycle";
import { createLogger } from "../src/lib/logger";
import {
  type BridgeHub,
  type BridgeHubOptions,
  bridgeHubFor,
  configureBridge,
} from "../src/modules/bridge";
import { createJobsService, type EnqueueInput } from "../src/modules/jobs/service";
import { createTokensService } from "../src/modules/tokens/service";
import type { AppEnv } from "../src/types";
import { createTestClock, insertUser, type TestClock, testConfig } from "./support";

export interface BridgeServer {
  app: Hono<AppEnv>;
  deps: AppDeps;
  /** What modules received, including the presence the bridge replaced. */
  moduleDeps: ModuleDeps;
  hub: BridgeHub;
  bus: EventBus;
  clock: TestClock;
  port: number;
  /** Every bus event published, in order. */
  events: BusEvent[];
  logs: string[];
  close(): Promise<void>;
}

/**
 * Serves `createApp` on an ephemeral port, the way `startServer` does, with the hub configured
 * first: background timers are off unless a test asks for them, so tests drive sweeps and
 * dispatch rounds themselves.
 */
export async function startBridgeServer(
  db: Database,
  options: BridgeHubOptions & { clock?: TestClock } = {},
): Promise<BridgeServer> {
  const logs: string[] = [];
  const logger = createLogger({
    level: "trace",
    destination: { write: (line: string) => void logs.push(line) },
  });
  const clock = options.clock ?? createTestClock();
  const bus = createEventBus(logger);
  const events: BusEvent[] = [];
  const record = (event: BusEvent) => {
    events.push(event);
  };
  for (const type of [
    "job.enqueued",
    "device.revoked",
    "job.updated",
    "job.activity",
    "device.status",
    "conversation.message.created",
    "conversation.message.delta",
  ] as const satisfies readonly BusEventType[]) {
    bus.subscribe(type, record);
  }
  const deps: AppDeps = {
    db,
    bus,
    clock,
    logger,
    config: testConfig(),
    lifecycle: createLifecycle(logger),
  };

  let app: Hono<AppEnv> | undefined;
  let resolveListening: (info: AddressInfo) => void = () => {};
  const listening = new Promise<AddressInfo>((resolve) => {
    resolveListening = resolve;
  });
  const server = serve(
    {
      fetch: (request, env) => app?.fetch(request, env) ?? new Response(null, { status: 503 }),
      port: 0,
      hostname: "127.0.0.1",
    },
    (info) => resolveListening(info),
  );
  configureBridge(server, {
    dispatchIntervalMs: 0,
    reaperIntervalMs: 0,
    ...options,
  });
  deps.httpServer = server;
  let moduleDeps: ModuleDeps | undefined;
  app = createApp(deps, {
    modules: [
      (target, registered) => {
        moduleDeps = registered;
        return target;
      },
    ],
  });
  const info = await listening;
  const hub = bridgeHubFor(server);
  if (hub === undefined || moduleDeps === undefined) {
    throw new Error("the bridge module did not attach a hub");
  }

  return {
    app,
    deps,
    moduleDeps,
    hub,
    bus,
    clock,
    port: info.port,
    events,
    logs,
    async close() {
      await deps.lifecycle.close();
      const http = server as import("node:http").Server;
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

export interface Fixtures {
  userId: string;
  workspaceId: string;
}

export async function seedWorkspace(db: Database): Promise<Fixtures> {
  const user = await insertUser(db);
  const [workspace] = await db
    .insert(workspaces)
    .values({ slug: `bridge-${randomUUID()}`, name: "Bridge", createdBy: user.id })
    .returning();
  if (workspace === undefined) {
    throw new Error("workspace was not inserted");
  }
  return { userId: user.id, workspaceId: workspace.id };
}

export interface TestDevice {
  deviceId: string;
  tokenId: string;
  /** The device bearer secret, generated at runtime. */
  secret: string;
}

/** A paired device: a `device` token with the `bridge` scope and its devices row. */
export async function pairDevice(
  db: Database,
  userId: string,
  name = "Studio Mac",
): Promise<TestDevice> {
  const tokens = createTokensService({ db, clock: { now: () => new Date() } });
  const created = await tokens.create({ userId, kind: "device", name, scopes: ["bridge"] });
  const [device] = await db
    .insert(devices)
    .values({ name, platform: "darwin-arm64", tokenId: created.row.id, createdBy: userId })
    .returning();
  if (device === undefined) {
    throw new Error("device was not inserted");
  }
  return { deviceId: device.id, tokenId: created.row.id, secret: created.secret };
}

export async function createConversation(db: Database, fixtures: Fixtures): Promise<string> {
  const [conversation] = await db
    .insert(conversations)
    .values({ workspaceId: fixtures.workspaceId, createdBy: fixtures.userId, title: "Chat" })
    .returning();
  if (conversation === undefined) {
    throw new Error("conversation was not inserted");
  }
  return conversation.id;
}

/** Enqueues a job the way the API does, publishing `job.enqueued` on `bus`. */
export async function enqueue(
  db: Database,
  bus: EventBus,
  input: Omit<EnqueueInput, "payload" | "type"> & { type?: JobType; payload?: unknown },
) {
  const service = createJobsService({ db, bus });
  const { job } = await service.enqueue(db, {
    type: input.type ?? "system.ping",
    payload: input.payload ?? {},
    ...input,
  });
  return job;
}

export function producerChatPayload(fixtures: Fixtures, conversationId: string) {
  return {
    conversationId,
    workspaceId: fixtures.workspaceId,
    messageId: randomUUID(),
    text: "Draft a hook about bridges",
  };
}

export interface CloseInfo {
  code: number;
  reason: string;
}

export interface ConnectOptions {
  /** The bearer secret; omit to send no Authorization header. */
  secret?: string;
  headers?: Record<string, string>;
  autoPong?: boolean;
}

/**
 * A minimal studio agent built from the contracts codec over a real `ws` client. Every frame from
 * the server must parse with `parseServerMessage`, or the test fails.
 */
export class FakeAgent {
  readonly ws: WebSocket;
  readonly received: ServerToAgent[] = [];
  readonly invalidFrames: string[] = [];
  readonly closed: Promise<CloseInfo>;
  #cursor = 0;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    this.closed = new Promise((resolve) => {
      ws.on("close", (code, reason) => resolve({ code, reason: reason.toString() }));
    });
    ws.on("message", (data) => {
      const frame = data.toString();
      const parsed = parseServerMessage(frame);
      if (parsed.ok) {
        this.received.push(parsed.message);
      } else {
        this.invalidFrames.push(frame);
      }
    });
  }

  static url(port: number): string {
    return `ws://127.0.0.1:${port}${BRIDGE_PATH}`;
  }

  /** Opens a connection; resolves with the agent, or rejects with the HTTP status. */
  static connect(port: number, options: ConnectOptions = {}): Promise<FakeAgent> {
    const headers: Record<string, string> = { ...options.headers };
    if (options.secret !== undefined) {
      headers.authorization = `Bearer ${options.secret}`;
    }
    const ws = new WebSocket(FakeAgent.url(port), {
      headers,
      perMessageDeflate: false,
      autoPong: options.autoPong ?? true,
    });
    const agent = new FakeAgent(ws);
    return new Promise((resolve, reject) => {
      ws.once("open", () => resolve(agent));
      ws.once("unexpected-response", (_request, response) => {
        response.resume();
        ws.terminate();
        reject(new UpgradeRefused(response.statusCode ?? 0));
      });
      ws.once("error", (error) => reject(error));
    });
  }

  send(draft: AgentToServerDraft): void {
    this.ws.send(encode(draft));
  }

  sendRaw(frame: string): void {
    this.ws.send(frame);
  }

  /** Sends `hello` and waits for `hello.ok`. */
  async hello(
    options: { jobTypes?: JobType[]; credits?: Partial<Credits>; resume?: ResumeEntry[] } = {},
  ): Promise<ServerMessageOf<"hello.ok">> {
    this.send({
      type: "hello",
      payload: {
        protocol: PROTOCOL_VERSION,
        agentVersion: "0.1.0-test",
        platform: "darwin-arm64",
        jobTypes: options.jobTypes ?? ["system.ping", "producer.chat"],
        credits: { producer: 1, render: 1, ...options.credits },
        resume: options.resume ?? [],
      },
    });
    return this.next("hello.ok");
  }

  /** The next message of `type` after the previous `next` call, waiting for it if needed. */
  async next<T extends ServerToAgentType>(
    type: T,
    predicate: (message: ServerMessageOf<T>) => boolean = () => true,
    timeout = 5_000,
  ): Promise<ServerMessageOf<T>> {
    return vi.waitFor(
      () => {
        for (let i = this.#cursor; i < this.received.length; i += 1) {
          const message = this.received[i];
          if (message?.type === type && predicate(message as ServerMessageOf<T>)) {
            this.#cursor = i + 1;
            return message as ServerMessageOf<T>;
          }
        }
        throw new Error(`no ${type} message yet`);
      },
      { timeout, interval: 5 },
    );
  }

  /** Every message of `type` received so far. */
  all<T extends ServerToAgentType>(type: T): ServerMessageOf<T>[] {
    return this.received.filter((message): message is ServerMessageOf<T> => message.type === type);
  }

  /**
   * Waits until the server has handled everything sent so far: an event for a job that does not
   * exist is never stored, but it is acked in order.
   */
  async sync(): Promise<void> {
    const jobId = randomUUID();
    this.send({
      type: "job.event",
      payload: { jobId, seq: 1, kind: "log", data: { level: "debug", message: "sync" } },
    });
    await this.next("ack", (ack) => ack.payload.jobId === jobId);
  }

  accept(jobId: string): void {
    this.send({ type: "job.accept", payload: { jobId } });
  }

  close(): Promise<CloseInfo> {
    this.ws.close(1000, "test done");
    return this.closed;
  }
}

export class UpgradeRefused extends Error {
  constructor(readonly status: number) {
    super(`upgrade refused with ${status}`);
  }
}

/** Collects unhandled promise rejections for the duration of a test file. */
export function trackUnhandledRejections(): { readonly reasons: unknown[]; stop(): void } {
  const reasons: unknown[] = [];
  const listener = (reason: unknown) => {
    reasons.push(reason);
  };
  process.on("unhandledRejection", listener);
  return {
    reasons,
    stop: () => {
      process.off("unhandledRejection", listener);
    },
  };
}
