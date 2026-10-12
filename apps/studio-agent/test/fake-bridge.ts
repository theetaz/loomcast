import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import {
  type AgentMessageOf,
  type AgentToServer,
  type AgentToServerType,
  type AssignedJob,
  BRIDGE_LIMITS,
  BRIDGE_PATH,
  CLOSE_CODES,
  encode,
  parseAgentMessage,
  type ServerToAgentDraft,
} from "@loomcast/contracts";
import type WebSocket from "ws";
import { WebSocketServer } from "ws";
import { ids, TEST_TOKEN } from "./helpers";

export interface FakeBridgeOptions {
  readonly token?: string;
  /** Ack every durable event as soon as it arrives. */
  readonly autoAck?: boolean;
}

type Waiter = {
  readonly match: (message: AgentToServer) => boolean;
  readonly resolve: (message: AgentToServer) => void;
};

const WAIT_TIMEOUT_MS = 5_000;

/**
 * An in-process bridge server built from the contracts: it checks the bearer token during the
 * upgrade, validates every agent frame with `parseAgentMessage`, answers `hello` with `hello.ok`
 * and records what the agent sends.
 */
export class FakeBridge {
  /** Every valid message the agent sent, across connections, in arrival order. */
  readonly received: AgentToServer[] = [];
  /** Frames that failed to parse. */
  readonly invalid: string[] = [];
  /** Authorization headers of every upgrade request. */
  readonly authHeaders: (string | undefined)[] = [];
  /** Set to make the next upgrades fail with this HTTP status. */
  rejectUpgradesWith: number | null = null;
  autoAck: boolean;
  /** Number of sockets that completed the upgrade. */
  connections = 0;
  pongs = 0;

  readonly #http: Server;
  readonly #wss: WebSocketServer;
  readonly #token: string;
  readonly #waiters = new Set<Waiter>();
  #socket: WebSocket | null = null;

  private constructor(http: Server, options: FakeBridgeOptions) {
    this.#http = http;
    this.#token = options.token ?? TEST_TOKEN;
    this.autoAck = options.autoAck ?? false;
    this.#wss = new WebSocketServer({ noServer: true, maxPayload: BRIDGE_LIMITS.maxPayloadBytes });
    http.on("upgrade", (request, socket, head) => this.#upgrade(request, socket, head));
  }

  static async start(options: FakeBridgeOptions = {}): Promise<FakeBridge> {
    const http = createServer((_request, response) => {
      response.writeHead(404).end();
    });
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    return new FakeBridge(http, options);
  }

  get serverUrl(): string {
    const { port } = this.#http.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  get url(): string {
    return `${this.serverUrl.replace("http:", "ws:")}${BRIDGE_PATH}`;
  }

  /** Messages of one type, in arrival order. */
  messages<T extends AgentToServerType>(type: T): AgentMessageOf<T>[] {
    return this.received.filter((message): message is AgentMessageOf<T> => message.type === type);
  }

  /**
   * Resolves with the first message of `type` matching `predicate` among the messages at index
   * `from` or later, waiting for it to arrive if needed.
   */
  waitFor<T extends AgentToServerType>(
    type: T,
    predicate: (message: AgentMessageOf<T>) => boolean = () => true,
    from = 0,
  ): Promise<AgentMessageOf<T>> {
    const match = (message: AgentToServer): message is AgentMessageOf<T> =>
      message.type === type && predicate(message as AgentMessageOf<T>);
    const existing = this.received.slice(from).find(match);
    if (existing !== undefined) {
      return Promise.resolve(existing);
    }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        match,
        resolve: (message) => {
          clearTimeout(timer);
          resolve(message as AgentMessageOf<T>);
        },
      };
      const timer = setTimeout(() => {
        this.#waiters.delete(waiter);
        reject(new Error(`Timed out waiting for "${type}"`));
      }, WAIT_TIMEOUT_MS);
      this.#waiters.add(waiter);
    });
  }

  send(draft: ServerToAgentDraft): void {
    this.sendRaw(encode(draft));
  }

  sendRaw(frame: string): void {
    if (this.#socket === null) {
      throw new Error("No agent is connected");
    }
    this.#socket.send(frame);
  }

  assign(job: Partial<AssignedJob> & Pick<AssignedJob, "id" | "type">, leaseMs = 600_000): void {
    this.send({
      type: "job.assign",
      payload: {
        job: { attempt: 1, payload: {}, projectId: ids.project, ...job },
        leaseMs,
      },
    });
  }

  cancel(jobId: string): void {
    this.send({ type: "job.cancel", payload: { jobId } });
  }

  ack(jobId: string, upToSeq: number): void {
    this.send({ type: "ack", payload: { jobId, upToSeq } });
  }

  ping(): void {
    this.#socket?.ping();
  }

  /** Kills the socket without a close frame, as a network failure would. */
  dropConnection(): void {
    this.#socket?.terminate();
  }

  closeWith(code: number, reason = ""): void {
    this.#socket?.close(code, reason);
  }

  async close(): Promise<void> {
    for (const client of this.#wss.clients) {
      client.terminate();
    }
    await new Promise<void>((resolve) => this.#wss.close(() => resolve()));
    this.#http.closeAllConnections();
    await new Promise<void>((resolve) => this.#http.close(() => resolve()));
  }

  #upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.authHeaders.push(request.headers.authorization);
    const status =
      this.rejectUpgradesWith ??
      (request.url !== BRIDGE_PATH
        ? 404
        : request.headers.origin !== undefined ||
            request.headers.authorization !== `Bearer ${this.#token}`
          ? 401
          : null);
    if (status !== null) {
      socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\n\r\n`);
      return;
    }
    this.#wss.handleUpgrade(request, socket, head, (ws) => this.#accept(ws));
  }

  #accept(ws: WebSocket): void {
    this.connections += 1;
    this.#socket = ws;
    ws.on("pong", () => {
      this.pongs += 1;
    });
    ws.on("message", (data) => {
      const frame = data.toString();
      const parsed = parseAgentMessage(frame);
      if (!parsed.ok) {
        this.invalid.push(frame);
        ws.close(CLOSE_CODES.malformedMessage, parsed.message);
        return;
      }
      this.#receive(ws, parsed.message);
    });
    ws.on("close", () => {
      if (this.#socket === ws) {
        this.#socket = null;
      }
    });
  }

  #receive(ws: WebSocket, message: AgentToServer): void {
    this.received.push(message);
    if (message.type === "hello") {
      ws.send(
        encode({
          type: "hello.ok",
          ref: message.id,
          payload: {
            deviceId: ids.device,
            serverTime: new Date().toISOString(),
            heartbeatMs: 20_000,
            leaseMs: 600_000,
            limits: {
              maxPayloadBytes: BRIDGE_LIMITS.maxPayloadBytes,
              maxStreamTextLength: BRIDGE_LIMITS.maxStreamTextLength,
            },
          },
        }),
      );
    }
    if (message.type === "job.event" && this.autoAck) {
      ws.send(
        encode({
          type: "ack",
          payload: { jobId: message.payload.jobId, upToSeq: message.payload.seq },
        }),
      );
    }
    for (const waiter of this.#waiters) {
      if (waiter.match(message)) {
        this.#waiters.delete(waiter);
        waiter.resolve(message);
      }
    }
  }
}
