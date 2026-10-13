import {
  type AgentToServerDraft,
  type AssignedJob,
  allowsEventKind,
  BRIDGE_LIMITS,
  BRIDGE_TIMINGS,
  type ConcurrencyClass,
  type Credits,
  getJobDefinition,
  IdSchema,
  isJobType,
  type JobError,
  type JobEventData,
  type JobEventKind,
  type JobPayload,
  type JobType,
  MessageIdSchema,
  type ParseFailure,
  parseJobPayload,
  parseJobResult,
  type ResumeEntry,
  type ServerMessageOf,
} from "@loomcast/contracts";
import { z } from "zod";
import type { ServerJobMessage } from "./connection";
import {
  createMcpCredentials,
  type Handler,
  type HandlerCredentials,
  type HandlerRegistry,
  type JobContext,
  JobFailure,
} from "./handlers";
import type { JobOutcome, Journal, JournalEntry } from "./journal";
import type { Logger } from "./logger";
import type { Outbox } from "./outbox";

/** The part of the bridge connection the runner uses. */
export interface BridgeTransport {
  /** True while the connection has received `hello.ok`. */
  readonly ready: boolean;
  readonly bufferedAmount: number;
  /** Returns false when the message could not be handed to a ready socket. */
  send(draft: AgentToServerDraft): boolean;
}

export interface RunnerOptions {
  readonly handlers: HandlerRegistry;
  readonly outbox: Outbox;
  readonly journal: Journal;
  readonly transport: BridgeTransport;
  /** Jobs allowed to run at once per concurrency class. */
  readonly concurrency: Credits;
  readonly log: Logger;
  /**
   * The paired server's URL. Job credentials name a server path, which is resolved against it, so
   * a job token is only ever sent back to the server that issued it. Without it, credentials are
   * ignored.
   */
  readonly serverUrl?: string;
  readonly heartbeatMs?: number;
  readonly streamBatchMs?: number;
  /** Overrides the registry timeout of a job type. */
  readonly timeoutMs?: (type: JobType) => number;
  readonly now?: () => Date;
}

interface ActiveJob {
  readonly job: AssignedJob;
  readonly concurrencyClass: ConcurrencyClass;
  readonly controller: AbortController;
  readonly log: Logger;
  /** Set when the runner aborts the job; it becomes the job's error. */
  abortError: JobError | null;
  done: boolean;
  finished: Promise<void>;
  timeout: NodeJS.Timeout | null;
  streamBuffer: string;
  streamTimer: NodeJS.Timeout | null;
  droppedStreamChars: number;
}

const INTERRUPTED: JobError = {
  code: "interrupted",
  message: "The studio agent stopped while the job was running",
  retryable: true,
};

const CANCELLED: JobError = {
  code: "cancelled",
  message: "The job was cancelled",
  retryable: false,
};

/**
 * Runs assigned jobs from the fixed handler registry.
 *
 * - Rejects job types without a handler, payloads that fail the registry schema, and jobs beyond
 *   the free credits of their concurrency class.
 * - Writes durable events to the outbox before sending them, replays them after a reconnect and
 *   settles a job's outbox once its events are acked and its outcome has been sent.
 * - Journals every outcome, so a re-assigned finished job is answered without running again.
 * - Aborts jobs on `job.cancel`, on the registry timeout and on shutdown.
 */
export class JobRunner {
  readonly #handlers: HandlerRegistry;
  readonly #outbox: Outbox;
  readonly #journal: Journal;
  readonly #transport: BridgeTransport;
  readonly #concurrency: Credits;
  readonly #log: Logger;
  readonly #serverUrl: string | undefined;
  readonly #heartbeatMs: number;
  readonly #streamBatchMs: number;
  readonly #timeoutMs: (type: JobType) => number;
  readonly #now: () => Date;
  readonly #running = new Map<string, ActiveJob>();
  /** Jobs whose outcome was handed to the socket of the current connection. */
  readonly #delivered = new Set<string>();
  #heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(options: RunnerOptions) {
    this.#handlers = options.handlers;
    this.#outbox = options.outbox;
    this.#journal = options.journal;
    this.#transport = options.transport;
    this.#concurrency = options.concurrency;
    this.#log = options.log;
    this.#serverUrl = options.serverUrl;
    this.#heartbeatMs = options.heartbeatMs ?? BRIDGE_TIMINGS.jobHeartbeatMs;
    this.#streamBatchMs = options.streamBatchMs ?? BRIDGE_TIMINGS.streamBatchMs;
    this.#timeoutMs = options.timeoutMs ?? ((type) => getJobDefinition(type).timeoutMs);
    this.#now = options.now ?? (() => new Date());
  }

  /** The job types advertised in `hello`. */
  jobTypes(): JobType[] {
    return this.#handlers.types();
  }

  /** Free slots per concurrency class. */
  credits(): Credits {
    return { producer: this.#free("producer"), render: this.#free("render") };
  }

  /** The `hello.resume` list. */
  resume(): ResumeEntry[] {
    return this.#outbox.resumeEntries();
  }

  runningJobIds(): string[] {
    return [...this.#running.keys()];
  }

  /**
   * Fails jobs that were running when the agent last stopped. Their handlers cannot be resumed in
   * a new process, so they end as `interrupted` (retryable) and are reported on the next connect.
   */
  recoverInterrupted(): void {
    for (const jobId of this.#outbox.jobIds()) {
      const job = this.#outbox.job(jobId);
      const entry = this.#journal.get(jobId);
      if (job === undefined || this.#running.has(jobId)) {
        continue;
      }
      if (entry === undefined || entry.attempt < job.attempt) {
        this.#log.warn("job was interrupted by an agent restart", { jobId, jobType: job.type });
        this.#journal.record({
          jobId,
          type: job.type,
          attempt: job.attempt,
          finishedAt: this.#now().toISOString(),
          lastSeq: this.#outbox.lastSeq(jobId),
          outcome: { status: "failed", error: INTERRUPTED },
        });
      }
    }
  }

  /** `hello.ok` arrived: replay unacked events and unconfirmed outcomes. */
  connected(): void {
    this.#delivered.clear();
    for (const jobId of this.#outbox.jobIds()) {
      for (const event of this.#outbox.pending(jobId)) {
        this.#transport.send({ type: "job.event", payload: event });
      }
      const entry = this.#journal.get(jobId);
      if (entry !== undefined && !this.#running.has(jobId)) {
        this.#sendOutcome(entry);
      }
    }
  }

  disconnected(): void {
    this.#delivered.clear();
  }

  handle(message: ServerJobMessage): void {
    switch (message.type) {
      case "job.assign":
        this.#assign(message);
        return;
      case "job.cancel":
        this.#cancel(message.payload.jobId);
        return;
      case "ack":
        this.#outbox.ack(message.payload.jobId, message.payload.upToSeq);
        this.#settle(message.payload.jobId);
        return;
      case "error":
        return;
    }
  }

  /**
   * A frame that failed validation. An assignment the agent cannot read, for example one with a
   * job type unknown to this agent version, is still answered with `job.reject`.
   */
  invalidFrame(frame: string, failure: ParseFailure): void {
    const assignment = readUnparsedAssignment(frame);
    if (assignment === null) {
      this.#log.warn("ignoring an invalid frame from the server", {
        reason: failure.reason,
        message: failure.message,
      });
      return;
    }
    this.#reject(assignment.jobId, assignment.reason, assignment.ref);
  }

  /** Aborts every running job as interrupted and waits for them to finish. */
  async shutdown(): Promise<void> {
    const active = [...this.#running.values()];
    for (const job of active) {
      this.#abort(job, INTERRUPTED);
    }
    await Promise.all(active.map((job) => job.finished));
    this.#stopHeartbeat();
  }

  #assign(message: ServerMessageOf<"job.assign">): void {
    const { job } = message.payload;
    const ref = message.id;
    if (this.#running.has(job.id)) {
      this.#transport.send({ type: "job.accept", ref, payload: { jobId: job.id } });
      return;
    }
    const finished = this.#journal.get(job.id);
    if (
      finished !== undefined &&
      (finished.outcome.status === "succeeded" || job.attempt <= finished.attempt)
    ) {
      this.#log.info("job already finished; replaying the journaled outcome", {
        jobId: job.id,
        status: finished.outcome.status,
      });
      this.#transport.send({ type: "job.accept", ref, payload: { jobId: job.id } });
      this.#sendOutcome(finished);
      return;
    }
    const handler = this.#handlers.get(job.type);
    if (handler === undefined) {
      this.#reject(job.id, "unsupported_job_type", ref);
      return;
    }
    const payload = parseJobPayload(job.type, job.payload);
    if (!payload.success) {
      this.#reject(job.id, `invalid_payload: ${describeIssues(payload.error.issues)}`, ref);
      return;
    }
    if (this.#free(getJobDefinition(job.type).concurrencyClass) <= 0) {
      this.#reject(job.id, "no_credits", ref);
      return;
    }
    const credentials = this.#credentials(job, message.payload.credentials);
    if (credentials === null) {
      this.#reject(job.id, "invalid_credentials", ref);
      return;
    }
    this.#start(job, job.type, handler, payload.data, credentials, ref, finished?.lastSeq ?? 0);
  }

  /**
   * The in-memory credentials of an assignment. They go to the handler only: they are never
   * logged and never written to the outbox or the journal. Returns null for credentials that
   * would leave the paired server.
   */
  #credentials(
    job: AssignedJob,
    sent: ServerMessageOf<"job.assign">["payload"]["credentials"],
  ): HandlerCredentials | null {
    if (sent === undefined) {
      return {};
    }
    if (getJobDefinition(job.type).mcpAccess === "none") {
      this.#log.warn("ignoring credentials sent for a job type without MCP access", {
        jobId: job.id,
        jobType: job.type,
      });
      return {};
    }
    if (this.#serverUrl === undefined) {
      this.#log.warn("ignoring job credentials: no server URL to resolve them against", {
        jobId: job.id,
      });
      return {};
    }
    const { endpoint, token, expiresAt } = sent.mcp;
    const server = new URL(this.#serverUrl);
    const url = new URL(endpoint, server);
    if (url.origin !== server.origin) {
      return null;
    }
    return { mcp: createMcpCredentials(url, token, expiresAt) };
  }

  #start<T extends JobType>(
    job: AssignedJob,
    type: T,
    handler: Handler<T>,
    payload: JobPayload<T>,
    credentials: HandlerCredentials,
    ref: string,
    startSeq: number,
  ): void {
    this.#outbox.open(job.id, { type, attempt: job.attempt }, startSeq);
    const active: ActiveJob = {
      job,
      concurrencyClass: getJobDefinition(type).concurrencyClass,
      controller: new AbortController(),
      log: this.#log.child({ jobId: job.id, jobType: type }),
      abortError: null,
      done: false,
      finished: Promise.resolve(),
      timeout: null,
      streamBuffer: "",
      streamTimer: null,
      droppedStreamChars: 0,
    };
    this.#running.set(job.id, active);
    this.#transport.send({ type: "job.accept", ref, payload: { jobId: job.id } });
    this.#sendCredits();
    this.#startHeartbeat();

    const timeoutMs = this.#timeoutMs(type);
    active.timeout = setTimeout(() => {
      this.#abort(active, {
        code: "timeout",
        message: `The job ran longer than its ${timeoutMs} ms limit`,
        retryable: true,
      });
    }, timeoutMs);

    const ctx: JobContext<T> = {
      job: { ...job, type, payload },
      credentials,
      emit: (kind, data) => this.#emit(active, kind, data),
      stream: (text) => this.#stream(active, text),
      signal: active.controller.signal,
      log: active.log,
    };
    active.log.info("job started", { attempt: job.attempt });
    active.finished = this.#execute(active, type, handler, ctx)
      .then((outcome) => this.#finish(active, outcome))
      .catch((error: unknown) => {
        active.log.error("could not record the job outcome", { error: errorMessage(error) });
      });
  }

  async #execute<T extends JobType>(
    active: ActiveJob,
    type: T,
    handler: Handler<T>,
    ctx: JobContext<T>,
  ): Promise<JobOutcome> {
    const signal = active.controller.signal;
    // A handler that ignores its signal must not hold its credit: the abort settles the job.
    const aborted = new Promise<never>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
    const running = Promise.resolve().then(() => handler(ctx));
    aborted.catch(() => {});
    running.catch(() => {});
    try {
      const result = await Promise.race([running, aborted]);
      if (active.abortError !== null) {
        return { status: "failed", error: active.abortError };
      }
      const parsed = parseJobResult(type, result);
      if (!parsed.success) {
        active.log.error("handler returned an invalid result", {
          issues: describeIssues(parsed.error.issues),
        });
        return {
          status: "failed",
          error: {
            code: "invalid_result",
            message: "The job produced an invalid result",
            retryable: false,
          },
        };
      }
      return { status: "succeeded", result: parsed.data };
    } catch (error) {
      if (active.abortError !== null) {
        return { status: "failed", error: active.abortError };
      }
      if (error instanceof JobFailure) {
        return { status: "failed", error: error.toJobError() };
      }
      active.log.error("job handler failed", { error: errorMessage(error) });
      return {
        status: "failed",
        error: {
          code: "internal",
          message: truncate(errorMessage(error), 2_000),
          retryable: false,
        },
      };
    }
  }

  #finish(active: ActiveJob, outcome: JobOutcome): void {
    const { job } = active;
    active.done = true;
    if (active.timeout !== null) {
      clearTimeout(active.timeout);
    }
    this.#flushStream(active);
    if (active.droppedStreamChars > 0) {
      active.log.debug("dropped streamed text under backpressure", {
        characters: active.droppedStreamChars,
      });
    }
    this.#running.delete(job.id);
    const entry: JournalEntry = {
      jobId: job.id,
      type: job.type,
      attempt: job.attempt,
      finishedAt: this.#now().toISOString(),
      lastSeq: this.#outbox.lastSeq(job.id),
      outcome,
    };
    this.#journal.record(entry);
    active.log.info("job finished", {
      status: outcome.status,
      code: outcome.status === "failed" ? outcome.error.code : undefined,
    });
    this.#sendOutcome(entry);
    this.#sendCredits();
    if (this.#running.size === 0) {
      this.#stopHeartbeat();
    }
  }

  #sendOutcome(entry: JournalEntry): void {
    const { jobId, outcome } = entry;
    const draft: AgentToServerDraft =
      outcome.status === "succeeded"
        ? { type: "job.complete", payload: { jobId, result: outcome.result } }
        : { type: "job.fail", payload: { jobId, error: outcome.error } };
    if (this.#transport.send(draft)) {
      this.#delivered.add(jobId);
      this.#settle(jobId);
    }
  }

  /** Deletes a finished job's outbox once its events are acked and its outcome was sent. */
  #settle(jobId: string): void {
    if (
      this.#outbox.has(jobId) &&
      !this.#running.has(jobId) &&
      this.#delivered.has(jobId) &&
      this.#journal.get(jobId) !== undefined &&
      this.#outbox.pending(jobId).length === 0
    ) {
      this.#outbox.remove(jobId);
      this.#delivered.delete(jobId);
    }
  }

  #cancel(jobId: string): void {
    const active = this.#running.get(jobId);
    if (active === undefined) {
      this.#log.debug("ignoring cancel for a job that is not running", { jobId });
      return;
    }
    active.log.info("cancelling job");
    this.#abort(active, CANCELLED);
  }

  #abort(active: ActiveJob, error: JobError): void {
    if (active.done || active.abortError !== null) {
      return;
    }
    active.abortError = error;
    active.controller.abort(error);
  }

  #reject(jobId: string, reason: string, ref?: string): void {
    this.#log.warn("rejecting job", { jobId, reason });
    this.#transport.send({
      type: "job.reject",
      ref,
      payload: { jobId, reason: truncate(reason, 500) },
    });
  }

  #emit<K extends JobEventKind>(active: ActiveJob, kind: K, data: JobEventData<K>): void {
    const { job } = active;
    if (active.done) {
      throw new Error(`Job ${job.id} has finished; the "${kind}" event was not recorded`);
    }
    if (!allowsEventKind(job.type, kind)) {
      throw new Error(`"${job.type}" jobs may not emit "${kind}" events`);
    }
    const event = this.#outbox.append(job.id, kind, data);
    this.#transport.send({ type: "job.event", payload: event });
  }

  #stream(active: ActiveJob, text: string): void {
    if (active.done || text.length === 0) {
      return;
    }
    active.streamBuffer += text;
    active.streamTimer ??= setTimeout(() => {
      active.streamTimer = null;
      this.#flushStream(active);
    }, this.#streamBatchMs);
  }

  /** Sends the batched deltas, or drops them when the socket is backed up or offline. */
  #flushStream(active: ActiveJob): void {
    if (active.streamTimer !== null) {
      clearTimeout(active.streamTimer);
      active.streamTimer = null;
    }
    const text = active.streamBuffer;
    active.streamBuffer = "";
    let sent = 0;
    for (const chunk of chunkText(text, BRIDGE_LIMITS.maxStreamTextLength)) {
      if (
        !this.#transport.ready ||
        this.#transport.bufferedAmount > BRIDGE_LIMITS.backpressureBytes
      ) {
        active.droppedStreamChars += text.length - sent;
        return;
      }
      this.#transport.send({
        type: "job.stream",
        payload: { jobId: active.job.id, kind: "assistant.delta", text: chunk },
      });
      sent += chunk.length;
    }
  }

  #free(concurrencyClass: ConcurrencyClass): number {
    let running = 0;
    for (const active of this.#running.values()) {
      if (active.concurrencyClass === concurrencyClass) {
        running += 1;
      }
    }
    return Math.max(0, this.#concurrency[concurrencyClass] - running);
  }

  #sendCredits(): void {
    this.#transport.send({ type: "credits", payload: this.credits() });
  }

  #startHeartbeat(): void {
    this.#heartbeatTimer ??= setInterval(() => {
      const jobIds = this.runningJobIds().slice(0, BRIDGE_LIMITS.maxJobsPerMessage);
      if (jobIds.length > 0) {
        this.#transport.send({ type: "job.heartbeat", payload: { jobIds } });
      }
    }, this.#heartbeatMs);
  }

  #stopHeartbeat(): void {
    if (this.#heartbeatTimer !== null) {
      clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = null;
    }
  }
}

const UnparsedAssignmentSchema = z.object({
  type: z.literal("job.assign"),
  id: z.unknown(),
  payload: z.object({ job: z.object({ id: IdSchema, type: z.unknown() }) }),
});

/** The job id and a reject reason of a `job.assign` frame that failed full validation. */
function readUnparsedAssignment(
  frame: string,
): { jobId: string; reason: string; ref?: string } | null {
  let value: unknown;
  try {
    value = JSON.parse(frame);
  } catch {
    return null;
  }
  const result = UnparsedAssignmentSchema.safeParse(value);
  if (!result.success) {
    return null;
  }
  const { id, payload } = result.data;
  const type = payload.job.type;
  const ref = MessageIdSchema.safeParse(id);
  return {
    jobId: payload.job.id,
    reason:
      typeof type === "string" && !isJobType(type) ? "unsupported_job_type" : "invalid_assignment",
    ref: ref.success ? ref.data : undefined,
  };
}

/** Splits text into chunks of at most `max` UTF-16 units without splitting a surrogate pair. */
export function chunkText(text: string, max: number): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + max, text.length);
    const last = text.charCodeAt(end - 1);
    if (end < text.length && end - start > 1 && last >= 0xd800 && last <= 0xdbff) {
      end -= 1;
    }
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}

function describeIssues(issues: readonly z.core.$ZodIssue[]): string {
  return issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
