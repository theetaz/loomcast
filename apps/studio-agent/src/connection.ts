import {
  type AgentMessageOf,
  type AgentToServerDraft,
  BRIDGE_LIMITS,
  BRIDGE_TIMINGS,
  BridgeEncodeError,
  CLOSE_CODES,
  encode,
  type ParseFailure,
  parseServerMessage,
  type ServerMessageOf,
  type ServerToAgent,
} from "@loomcast/contracts";
import WebSocket from "ws";
import { AGENT_VERSION } from "./agent-info";
import { Backoff, type BackoffPolicy, DEFAULT_BACKOFF } from "./backoff";
import type { Logger } from "./logger";

/** Why the connection stopped for good. Every other close leads to a reconnect. */
export type StopReason =
  /** `stop()` was called. */
  | "stopped"
  /** The server refused the device token (close 4401 or HTTP 401). */
  | "unauthorized"
  /** The device was revoked (close 4403 or HTTP 403). */
  | "revoked"
  /** A newer connection of this device replaced this one (close 4409). */
  | "superseded"
  /** The server does not speak this protocol version (close 4426). */
  | "unsupported_protocol";

export type HelloPayload = AgentMessageOf<"hello">["payload"];
export type HelloOk = ServerMessageOf<"hello.ok">;
export type ServerJobMessage = Exclude<ServerToAgent, HelloOk>;

export interface ConnectionHandlers {
  /** Builds `hello` each time a socket opens, so job types, credits and resume list are fresh. */
  hello(): HelloPayload;
  /** `hello.ok` arrived: job traffic may flow. */
  ready(message: HelloOk): void;
  /** Any other server message on a ready connection. */
  message(message: ServerJobMessage): void;
  /** A frame that failed to parse. The socket stays open. */
  invalidFrame(frame: string, failure: ParseFailure): void;
  /** A ready connection was lost. */
  disconnected(): void;
}

export interface ConnectionOptions {
  /** `wss://host/bridge/v1`. */
  readonly url: string;
  readonly token: string;
  readonly handlers: ConnectionHandlers;
  readonly log: Logger;
  readonly backoff?: BackoffPolicy;
  readonly random?: () => number;
  /** The server is considered gone after this long without a ping. */
  readonly deadServerMs?: number;
  /** An open socket that gets no `hello.ok` within this time is dropped. */
  readonly helloTimeoutMs?: number;
  readonly handshakeTimeoutMs?: number;
}

const HELLO_TIMEOUT_MS = 30_000;
const HANDSHAKE_TIMEOUT_MS = 15_000;

/**
 * The studio agent's only network link: an outbound WebSocket to the bridge.
 *
 * It authenticates with the device token, sends `hello` on every open, answers pings (the `ws`
 * library pongs automatically), drops a socket that has not been pinged for `deadServerMs`, and
 * reconnects with full-jitter backoff until the server says the device must be paired again or
 * that another connection replaced it.
 */
export class BridgeConnection {
  readonly done: Promise<StopReason>;
  readonly #options: ConnectionOptions;
  readonly #log: Logger;
  readonly #backoff: Backoff;
  #resolveDone: (reason: StopReason) => void = () => {};
  #socket: WebSocket | null = null;
  #ready = false;
  #stopReason: StopReason | null = null;
  #httpStatus: number | null = null;
  #reconnectTimer: NodeJS.Timeout | null = null;
  #deadServerTimer: NodeJS.Timeout | null = null;
  #helloTimer: NodeJS.Timeout | null = null;

  constructor(options: ConnectionOptions) {
    this.#options = options;
    this.#log = options.log;
    this.#backoff = new Backoff(options.backoff ?? DEFAULT_BACKOFF, options.random);
    this.done = new Promise((resolve) => {
      this.#resolveDone = resolve;
    });
  }

  /** True between `hello.ok` and the socket closing. */
  get ready(): boolean {
    return this.#ready;
  }

  /** Bytes queued on the socket but not yet written. */
  get bufferedAmount(): number {
    return this.#socket?.bufferedAmount ?? 0;
  }

  start(): void {
    if (this.#socket === null && this.#stopReason === null) {
      this.#connect();
    }
  }

  /** Closes the connection and stops reconnecting. */
  stop(): void {
    this.#finish("stopped");
  }

  /**
   * Sends one message on a ready connection. Returns false when there is no ready connection or
   * the message cannot be encoded; durable messages are then replayed from the outbox later.
   */
  send(draft: AgentToServerDraft): boolean {
    const socket = this.#socket;
    if (!this.#ready || socket === null || socket.readyState !== WebSocket.OPEN) {
      return false;
    }
    return this.#write(socket, draft);
  }

  #connect(): void {
    this.#httpStatus = null;
    this.#log.debug("connecting to the bridge", { url: this.#options.url });
    const socket = new WebSocket(this.#options.url, {
      headers: {
        authorization: `Bearer ${this.#options.token}`,
        "user-agent": `loomcast-studio-agent/${AGENT_VERSION}`,
      },
      maxPayload: BRIDGE_LIMITS.maxPayloadBytes,
      handshakeTimeout: this.#options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS,
      perMessageDeflate: false,
      followRedirects: false,
    });
    this.#socket = socket;

    socket.on("unexpected-response", (_request, response) => {
      this.#httpStatus = response.statusCode ?? null;
      response.resume();
      socket.terminate();
    });
    socket.on("open", () => this.#onOpen(socket));
    socket.on("ping", () => this.#armDeadServerTimer(socket));
    socket.on("message", (data, isBinary) => this.#onMessage(data, isBinary));
    socket.on("error", (error) => {
      this.#log.debug("bridge socket error", { error: error.message });
    });
    socket.on("close", (code, reason) => this.#onClose(socket, code, reason.toString()));
  }

  #onOpen(socket: WebSocket): void {
    this.#backoff.connected();
    this.#armDeadServerTimer(socket);
    this.#helloTimer = setTimeout(() => {
      this.#log.warn("no hello.ok from the server; reconnecting");
      socket.terminate();
    }, this.#options.helloTimeoutMs ?? HELLO_TIMEOUT_MS);
    this.#write(socket, { type: "hello", payload: this.#options.handlers.hello() });
  }

  #onMessage(data: WebSocket.RawData, isBinary: boolean): void {
    if (isBinary) {
      this.#log.warn("ignoring a binary frame from the server");
      return;
    }
    const frame = rawDataToString(data);
    const parsed = parseServerMessage(frame);
    if (!parsed.ok) {
      this.#options.handlers.invalidFrame(frame, parsed);
      return;
    }
    const message = parsed.message;
    if (message.type === "hello.ok") {
      this.#clearHelloTimer();
      this.#ready = true;
      this.#log.info("connected to the bridge", { deviceId: message.payload.deviceId });
      this.#options.handlers.ready(message);
      return;
    }
    if (message.type === "error") {
      this.#log.warn("bridge error", {
        code: message.payload.code,
        message: message.payload.message,
      });
    }
    if (!this.#ready) {
      this.#log.warn("ignoring a message received before hello.ok", { type: message.type });
      return;
    }
    this.#options.handlers.message(message);
  }

  #onClose(socket: WebSocket, code: number, reason: string): void {
    if (socket !== this.#socket) {
      return;
    }
    this.#socket = null;
    this.#clearSocketTimers();
    const wasReady = this.#ready;
    this.#ready = false;
    this.#backoff.disconnected();
    if (wasReady) {
      this.#options.handlers.disconnected();
    }
    if (this.#stopReason !== null) {
      this.#resolveDone(this.#stopReason);
      return;
    }

    const fatal = fatalReason(code, this.#httpStatus);
    if (fatal !== null) {
      this.#logFatal(fatal, code);
      this.#stopReason = fatal;
      this.#resolveDone(fatal);
      return;
    }

    const delayMs = this.#backoff.next();
    this.#log.info("bridge connection closed; reconnecting", {
      code,
      reason: reason || undefined,
      httpStatus: this.#httpStatus ?? undefined,
      attempt: this.#backoff.attempt,
      delayMs,
    });
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.#connect();
    }, delayMs);
  }

  #logFatal(reason: StopReason, code: number): void {
    switch (reason) {
      case "unauthorized":
      case "revoked":
        this.#log.error("the server refused this device; re-pair required", {
          code,
          httpStatus: this.#httpStatus ?? undefined,
          hint: "run `studio-agent pair --server <url> --code <code>`",
        });
        return;
      case "superseded":
        this.#log.info("another connection of this device replaced this one; exiting", { code });
        return;
      case "unsupported_protocol":
        this.#log.error("the server does not support this agent's protocol; update it", { code });
        return;
      case "stopped":
        return;
    }
  }

  #write(socket: WebSocket, draft: AgentToServerDraft): boolean {
    let frame: string;
    try {
      frame = encode(draft);
    } catch (error) {
      if (error instanceof BridgeEncodeError) {
        this.#log.error("dropping a message that does not match the protocol", {
          type: draft.type,
          error: error.message,
        });
        return false;
      }
      throw error;
    }
    socket.send(frame);
    return true;
  }

  #armDeadServerTimer(socket: WebSocket): void {
    if (this.#deadServerTimer !== null) {
      clearTimeout(this.#deadServerTimer);
    }
    const deadServerMs = this.#options.deadServerMs ?? BRIDGE_TIMINGS.agentDeadServerMs;
    this.#deadServerTimer = setTimeout(() => {
      this.#log.warn("no ping from the server; dropping the connection", { deadServerMs });
      socket.terminate();
    }, deadServerMs);
  }

  #clearHelloTimer(): void {
    if (this.#helloTimer !== null) {
      clearTimeout(this.#helloTimer);
      this.#helloTimer = null;
    }
  }

  #clearSocketTimers(): void {
    this.#clearHelloTimer();
    if (this.#deadServerTimer !== null) {
      clearTimeout(this.#deadServerTimer);
      this.#deadServerTimer = null;
    }
  }

  #finish(reason: StopReason): void {
    if (this.#stopReason !== null) {
      return;
    }
    this.#stopReason = reason;
    if (this.#reconnectTimer !== null) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    const socket = this.#socket;
    if (socket === null) {
      this.#resolveDone(reason);
      return;
    }
    socket.close(1000, "studio agent stopping");
  }
}

/** Close codes and upgrade statuses after which reconnecting cannot help. */
function fatalReason(code: number, httpStatus: number | null): StopReason | null {
  if (code === CLOSE_CODES.unauthorized || httpStatus === 401) {
    return "unauthorized";
  }
  if (code === CLOSE_CODES.revoked || httpStatus === 403) {
    return "revoked";
  }
  if (code === CLOSE_CODES.superseded) {
    return "superseded";
  }
  if (code === CLOSE_CODES.unsupportedProtocol) {
    return "unsupported_protocol";
  }
  return null;
}

function rawDataToString(data: WebSocket.RawData): string {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  return data.toString("utf8");
}
