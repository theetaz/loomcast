import type {
  AssignedJob,
  JobError,
  JobEventData,
  JobEventKind,
  JobPayload,
  JobResult,
  JobType,
} from "@loomcast/contracts";
import type { Logger } from "./logger";

/** A job as a handler sees it: the payload is already validated against the registry. */
export type RunningJob<T extends JobType> = Omit<AssignedJob, "type" | "payload"> & {
  readonly type: T;
  readonly payload: JobPayload<T>;
};

export interface JobContext<T extends JobType> {
  readonly job: RunningJob<T>;
  /**
   * Records a durable event. It is written to the outbox before it is sent and is replayed until
   * the server acks it. Only the event kinds the registry allows for the job type are accepted.
   */
  emit<K extends JobEventKind>(kind: K, data: JobEventData<K>): void;
  /** Streams assistant text. Deltas are batched, never stored and dropped under backpressure. */
  stream(text: string): void;
  /** Aborted when the job is cancelled, times out or the agent shuts down. */
  readonly signal: AbortSignal;
  readonly log: Logger;
}

/** Runs one job type. The result is validated against the registry before it is sent. */
export type Handler<T extends JobType> = (ctx: JobContext<T>) => Promise<JobResult<T>>;

/** Thrown by a handler to fail its job with a specific error code. */
export class JobFailure extends Error {
  override readonly name = "JobFailure";
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable = false) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }

  toJobError(): JobError {
    return { code: this.code, message: this.message, retryable: this.retryable };
  }
}

/**
 * The job types this agent runs. Anything not registered here is rejected, and no handler runs a
 * command taken from a job payload.
 */
export class HandlerRegistry {
  // Invariant: the handler stored under type `T` is a `Handler<T>`; `register` enforces it.
  readonly #handlers = new Map<JobType, unknown>();

  register<T extends JobType>(type: T, handler: Handler<T>): this {
    if (this.#handlers.has(type)) {
      throw new Error(`A handler for "${type}" is already registered`);
    }
    this.#handlers.set(type, handler);
    return this;
  }

  get<T extends JobType>(type: T): Handler<T> | undefined {
    return this.#handlers.get(type) as Handler<T> | undefined;
  }

  has(type: JobType): boolean {
    return this.#handlers.has(type);
  }

  /** The job types advertised in `hello`. */
  types(): JobType[] {
    return [...this.#handlers.keys()];
  }
}
