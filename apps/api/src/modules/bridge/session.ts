import {
  type AgentMessageOf,
  type AgentToServer,
  BRIDGE_LIMITS,
  BridgeEncodeError,
  CLOSE_CODES,
  type ConcurrencyClass,
  type Credits,
  encode,
  getJobDefinition,
  type JobCredentials,
  type JobType,
  PROTOCOL_VERSION,
  parseAgentMessage,
  type ServerToAgentDraft,
} from "@loomcast/contracts";
import { type Database, type JobRow, jobs } from "@loomcast/db";
import { eq } from "drizzle-orm";
import WebSocket from "ws";
import type { EventBus } from "../../lib/bus";
import type { Logger } from "../../lib/logger";
import type { Dispatcher, DispatchSession, DispatchTarget } from "../jobs/dispatcher";
import type { JobLifecycle } from "../jobs/lifecycle";

/** Messages received but not yet handled; a peer that floods past this is disconnected. */
const MAX_QUEUED_MESSAGES = 1_000;

/** How long a job stays excluded from dispatch to this agent after `job.cancel` was sent. */
const CANCELLING_TTL_MS = 60_000;

/** Close code for an internal error while handling a message (the agent reconnects). */
const CLOSE_INTERNAL_ERROR = 1011;
/** Close code for a peer that sends faster than the server can handle. */
const CLOSE_POLICY_VIOLATION = 1008;

export type AssignResult = "sent" | "closed" | "invalid";

export interface SessionTimings {
  /** Server ping interval, sent to the agent as `hello.ok.heartbeatMs`. */
  heartbeatMs: number;
  /** Job lease, sent as `hello.ok.leaseMs` and `job.assign.leaseMs`. */
  leaseMs: number;
}

/** What a session needs from its hub. */
export interface SessionHost {
  db: Database;
  bus: EventBus;
  logger: Logger;
  lifecycle: JobLifecycle;
  dispatcher: Dispatcher;
  timings: SessionTimings;
  /** Resolves when the previous connection of the same device has handled its messages. */
  previous(): Promise<void>;
  /** `hello` was handled: record the device as online. */
  ready(session: BridgeSession, hello: AgentMessageOf<"hello">["payload"]): Promise<void>;
}

type SessionState = "awaiting_hello" | "ready" | "closed";

interface StreamTarget {
  conversationId: string | null;
}

/**
 * One studio agent connection. Every frame is parsed with the contracts codec; anything that does
 * not validate closes the socket with 4400 (4426 for another protocol version). Messages are
 * handled one at a time, in arrival order, so durable events are stored in sequence and each
 * cumulative `ack` covers only stored events.
 *
 * Nothing but `hello.ok` is sent before `hello` has been handled, and a message other than
 * `hello` arriving first closes the connection.
 */
export class BridgeSession implements DispatchSession {
  readonly deviceId: string;
  readonly #ws: WebSocket;
  readonly #host: SessionHost;
  readonly #log: Logger;
  #state: SessionState = "awaiting_hello";
  /** Set when queued messages must not be handled any more (revoked, or a handler failed). */
  #halted = false;
  #closeCode: number | null = null;
  #queued = 0;
  #chain: Promise<void> = Promise.resolve();
  #missedPongs = 0;
  #jobTypes = new Set<JobType>();
  /** Free slots the agent last reported. */
  #credits: Credits = { producer: 0, render: 0 };
  /** Jobs sent with `job.assign` and not yet accepted or rejected, with their class. */
  readonly #pending = new Map<string, ConcurrencyClass>();
  /** Jobs this agent was told to stop, with the time the entry expires. */
  readonly #cancelling = new Map<string, number>();
  /** Highest seq acked per job on this connection, so acks never go backwards. */
  readonly #acked = new Map<string, number>();
  /** Jobs whose stream deltas may be relayed, with their conversation. */
  readonly #streams = new Map<string, StreamTarget>();

  constructor(ws: WebSocket, deviceId: string, host: SessionHost) {
    this.#ws = ws;
    this.deviceId = deviceId;
    this.#host = host;
    this.#log = host.logger.child({ deviceId });
    ws.on("message", (data, isBinary) => this.#receive(data, isBinary));
    ws.on("pong", () => {
      this.#missedPongs = 0;
    });
    ws.on("error", (error) => this.#log.debug({ err: error }, "bridge socket error"));
  }

  get ready(): boolean {
    return this.#state === "ready" && this.#ws.readyState === WebSocket.OPEN;
  }

  /** Resolves once every message received so far has been handled. */
  drained(): Promise<void> {
    return this.#chain;
  }

  /** Closes the connection. Messages already received are still handled unless `halt` is set. */
  close(code: number, reason: string, halt = false): void {
    if (halt) {
      this.#halted = true;
    }
    this.#closeCode ??= code;
    this.#state = "closed";
    if (this.#ws.readyState === WebSocket.OPEN || this.#ws.readyState === WebSocket.CONNECTING) {
      this.#ws.close(code, reason);
    }
  }

  #isClosed(): boolean {
    return this.#state === "closed";
  }

  /** The code this side closed the connection with, or null when the agent closed it. */
  get closeCode(): number | null {
    return this.#closeCode;
  }

  /** Drops the connection without a close handshake. */
  terminate(): void {
    this.#state = "closed";
    this.#ws.terminate();
  }

  /** Called when the socket closed, from either side. */
  closed(): void {
    this.#state = "closed";
  }

  /** One server ping. Returns false (and terminates the socket) after two unanswered pings. */
  ping(): boolean {
    if (this.#ws.readyState !== WebSocket.OPEN) {
      return true;
    }
    if (this.#missedPongs >= 2) {
      this.#log.info("studio agent missed two pings; terminating the connection");
      this.#ws.terminate();
      return false;
    }
    this.#missedPongs += 1;
    this.#ws.ping();
    return true;
  }

  // ---------------------------------------------------------------- dispatch

  target(): DispatchTarget | null {
    if (!this.ready) {
      return null;
    }
    const now = Date.now();
    for (const [jobId, expires] of this.#cancelling) {
      if (expires <= now) {
        this.#cancelling.delete(jobId);
      }
    }
    const credits = { ...this.#credits };
    for (const cls of this.#pending.values()) {
      credits[cls] = Math.max(0, credits[cls] - 1);
    }
    return {
      deviceId: this.deviceId,
      jobTypes: [...this.#jobTypes],
      credits,
      exclude: [...this.#cancelling.keys()],
    };
  }

  assign(job: JobRow, credentials: JobCredentials | null = null): boolean {
    const result = this.#assign(job, credentials);
    if (result === "invalid") {
      // The payload passed the registry when it was queued, so this is a bug, not a retry case.
      void this.#host.lifecycle
        .fail(this.deviceId, job.id, {
          code: "invalid_payload",
          message: "The job could not be sent to the studio agent.",
          retryable: false,
        })
        .catch((error: unknown) => this.#log.error({ err: error }, "could not fail the job"));
      return true;
    }
    return result === "sent";
  }

  /**
   * Writes one `job.assign` frame. `credentials` (the job token minted for this assignment) go
   * into this frame only: they are never kept on the session, logged or sent again. A later
   * assignment of the same job carries a fresh token.
   */
  #assign(job: JobRow, credentials: JobCredentials | null): AssignResult {
    if (!this.ready) {
      return "closed";
    }
    const draft: ServerToAgentDraft = {
      type: "job.assign",
      payload: {
        job: {
          id: job.id,
          type: job.type,
          attempt: job.attempt,
          payload: job.payload,
          projectId: job.projectId,
          ...(job.conversationId === null ? {} : { conversationId: job.conversationId }),
        },
        leaseMs: this.#host.timings.leaseMs,
        ...(credentials === null ? {} : { credentials }),
      },
    };
    let frame: string;
    try {
      frame = encode(draft);
    } catch (error) {
      if (error instanceof BridgeEncodeError) {
        // Only the issue paths and messages: the error never carries the frame or its token.
        this.#log.error(
          { jobId: job.id, issues: error.issues.map((issue) => issue.path.join(".")) },
          "job.assign does not match the protocol",
        );
        return "invalid";
      }
      throw error;
    }
    this.#ws.send(frame);
    this.#pending.set(job.id, getJobDefinition(job.type).concurrencyClass);
    return "sent";
  }

  /** Tells the agent to stop a job and keeps it from being dispatched here for a while. */
  cancel(jobId: string): void {
    this.#cancelling.set(jobId, Date.now() + CANCELLING_TTL_MS);
    this.#send({ type: "job.cancel", payload: { jobId } });
  }

  /** The job left this agent on the server side (for example, it was re-queued). */
  forget(jobId: string): void {
    this.#pending.delete(jobId);
    this.#streams.delete(jobId);
  }

  // ---------------------------------------------------------------- receiving

  #receive(data: WebSocket.RawData, isBinary: boolean): void {
    if (this.#halted) {
      return;
    }
    if (isBinary) {
      this.close(CLOSE_CODES.malformedMessage, "binary frames are not supported", true);
      return;
    }
    const frame = rawDataToString(data);
    const parsed = parseAgentMessage(frame);
    if (!parsed.ok) {
      const code = isOtherProtocolHello(frame) ? CLOSE_CODES.unsupportedProtocol : parsed.closeCode;
      this.#log.warn({ reason: parsed.reason, code }, "invalid frame from the studio agent");
      this.close(code, parsed.message.slice(0, 120), true);
      return;
    }
    if (this.#queued >= MAX_QUEUED_MESSAGES) {
      this.close(CLOSE_POLICY_VIOLATION, "too many messages", true);
      return;
    }
    const message = parsed.message;
    this.#queued += 1;
    this.#chain = this.#chain
      .then(async () => {
        if (!this.#halted) {
          await this.#handle(message);
        }
      })
      .catch((error: unknown) => {
        this.#log.error({ err: error, type: message.type }, "bridge message failed");
        this.close(CLOSE_INTERNAL_ERROR, "internal error", true);
      })
      .finally(() => {
        this.#queued -= 1;
      });
  }

  async #handle(message: AgentToServer): Promise<void> {
    if (message.type === "hello") {
      if (this.#state !== "awaiting_hello") {
        this.close(CLOSE_CODES.malformedMessage, "hello was already sent", true);
        return;
      }
      await this.#hello(message.payload);
      return;
    }
    if (this.#state === "awaiting_hello") {
      this.close(CLOSE_CODES.malformedMessage, "hello must be the first message", true);
      return;
    }
    switch (message.type) {
      case "job.accept":
        return this.#accept(message.payload.jobId);
      case "job.reject":
        return this.#reject(message.payload.jobId, message.payload.reason);
      case "job.event":
        return this.#event(message.payload);
      case "job.stream":
        return this.#stream(message.payload.jobId, message.payload.text);
      case "job.heartbeat":
        return this.#heartbeat(message.payload.jobIds);
      case "job.complete":
        return this.#finished(
          message.payload.jobId,
          this.#host.lifecycle.complete(
            this.deviceId,
            message.payload.jobId,
            message.payload.result,
          ),
        );
      case "job.fail":
        return this.#finished(
          message.payload.jobId,
          this.#host.lifecycle.fail(this.deviceId, message.payload.jobId, message.payload.error),
        );
      case "credits":
        this.#credits = { ...message.payload };
        this.#host.dispatcher.trigger();
        return;
    }
  }

  async #hello(hello: AgentMessageOf<"hello">["payload"]): Promise<void> {
    const { lifecycle, timings } = this.#host;
    // The previous connection of this device may still be handling an outcome or events; let it
    // finish so the resume list is checked against the latest state.
    await this.#host.previous();
    if (this.#isClosed()) {
      return;
    }
    this.#jobTypes = new Set(hello.jobTypes);
    this.#credits = { ...hello.credits };
    const resumed = await lifecycle.resume(this.deviceId, hello.resume, timings.leaseMs);
    if (this.#isClosed()) {
      return;
    }
    for (const job of resumed.kept) {
      this.#streams.set(job.id, { conversationId: job.conversationId });
    }
    await this.#host.ready(this, hello);
    if (this.#ws.readyState !== WebSocket.OPEN) {
      return;
    }
    this.#state = "ready";
    this.#send({
      type: "hello.ok",
      payload: {
        deviceId: this.deviceId,
        serverTime: new Date().toISOString(),
        heartbeatMs: timings.heartbeatMs,
        leaseMs: timings.leaseMs,
        limits: {
          maxPayloadBytes: BRIDGE_LIMITS.maxPayloadBytes,
          maxStreamTextLength: BRIDGE_LIMITS.maxStreamTextLength,
        },
      },
    });
    for (const jobId of resumed.cancel) {
      this.cancel(jobId);
    }
    this.#log.info(
      {
        agentVersion: hello.agentVersion,
        jobTypes: hello.jobTypes,
        resumed: resumed.kept.length,
        requeued: resumed.requeued.length,
      },
      "studio agent connected",
    );
    this.#host.dispatcher.trigger();
  }

  async #accept(jobId: string): Promise<void> {
    const cls = this.#pending.get(jobId);
    this.#pending.delete(jobId);
    const { outcome, job } = await this.#host.lifecycle.accept(
      this.deviceId,
      jobId,
      this.#host.timings.leaseMs,
    );
    if (outcome === "stale" || job === null) {
      this.cancel(jobId);
      return;
    }
    if (outcome === "started" && cls !== undefined) {
      // The agent reports fresh credits right after accepting; until then count the slot as used.
      this.#credits[cls] = Math.max(0, this.#credits[cls] - 1);
    }
    this.#streams.set(job.id, { conversationId: job.conversationId });
    if (job.cancelRequestedAt !== null) {
      this.cancel(jobId);
    }
  }

  async #reject(jobId: string, reason: string | undefined): Promise<void> {
    this.#pending.delete(jobId);
    const { applied, job } = await this.#host.lifecycle.reject(this.deviceId, jobId, reason);
    this.#log.info({ jobId, reason }, "studio agent rejected a job");
    if (applied && job !== null) {
      const cls = getJobDefinition(job.type).concurrencyClass;
      if (reason === "no_credits") {
        // Wait for the agent's next `credits` message before sending more of this class.
        this.#credits[cls] = 0;
      } else if (reason === "unsupported_job_type") {
        this.#jobTypes.delete(job.type);
      }
    }
    if (applied) {
      this.#host.dispatcher.trigger();
    }
  }

  async #event(event: AgentMessageOf<"job.event">["payload"]): Promise<void> {
    const result = await this.#host.lifecycle.recordEvent(
      this.deviceId,
      event,
      this.#host.timings.leaseMs,
    );
    if (result.invalidKind) {
      this.#send({
        type: "error",
        payload: {
          code: "invalid_event",
          message: `"${result.job?.type}" jobs do not emit "${event.kind}" events`,
        },
      });
    }
    // Acked whether stored now, stored before, or not for this device: the agent may drop it.
    const upToSeq = Math.max(this.#acked.get(event.jobId) ?? 0, event.seq);
    this.#acked.set(event.jobId, upToSeq);
    this.#send({ type: "ack", payload: { jobId: event.jobId, upToSeq } });
  }

  async #stream(jobId: string, text: string): Promise<void> {
    let target = this.#streams.get(jobId);
    if (target === undefined) {
      const [job] = await this.#host.db
        .select({
          conversationId: jobs.conversationId,
          claimedByDevice: jobs.claimedByDevice,
          status: jobs.status,
        })
        .from(jobs)
        .where(eq(jobs.id, jobId))
        .limit(1);
      if (job === undefined || job.claimedByDevice !== this.deviceId || job.status !== "running") {
        return;
      }
      target = { conversationId: job.conversationId };
      this.#streams.set(jobId, target);
    }
    if (target.conversationId === null) {
      return;
    }
    this.#host.bus.publish({
      type: "conversation.message.delta",
      payload: { conversationId: target.conversationId, jobId, text },
    });
  }

  async #heartbeat(jobIds: readonly string[]): Promise<void> {
    const extended = new Set(
      await this.#host.lifecycle.heartbeat(this.deviceId, jobIds, this.#host.timings.leaseMs),
    );
    for (const jobId of jobIds) {
      if (!extended.has(jobId) && !this.#cancelling.has(jobId)) {
        // The agent runs a job the server no longer gives it: stop it.
        this.cancel(jobId);
      }
    }
  }

  async #finished(jobId: string, outcome: Promise<{ applied: boolean }>): Promise<void> {
    const { applied } = await outcome;
    this.#pending.delete(jobId);
    this.#cancelling.delete(jobId);
    this.#streams.delete(jobId);
    this.#acked.delete(jobId);
    if (!applied) {
      this.#log.debug({ jobId }, "ignoring a duplicate or late job outcome");
    }
    this.#host.dispatcher.trigger();
  }

  #send(draft: ServerToAgentDraft): boolean {
    if (this.#ws.readyState !== WebSocket.OPEN) {
      return false;
    }
    if (draft.type !== "hello.ok" && this.#state !== "ready") {
      return false;
    }
    try {
      this.#ws.send(encode(draft));
      return true;
    } catch (error) {
      if (error instanceof BridgeEncodeError) {
        this.#log.error({ type: draft.type, err: error }, "dropping an invalid server message");
        return false;
      }
      throw error;
    }
  }
}

/** A `hello` that announces a protocol version this server does not speak. */
function isOtherProtocolHello(frame: string): boolean {
  try {
    const value = JSON.parse(frame) as { type?: unknown; payload?: { protocol?: unknown } };
    return (
      value !== null &&
      typeof value === "object" &&
      value.type === "hello" &&
      typeof value.payload?.protocol === "number" &&
      value.payload.protocol !== PROTOCOL_VERSION
    );
  } catch {
    return false;
  }
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
