import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import {
  isScheduledTaskKind,
  type JsonObject,
  parseScheduledTaskPayload,
  RECURRING_TASK_INTERVAL_MS,
  type ScheduledTaskKind,
  type ScheduledTaskPayload,
  scheduledTaskRegistry,
  TASK_STATUSES,
  type TaskError,
  type TaskStatus,
  taskRetryDelayMs,
} from "@loomcast/contracts";
import {
  claimDueTasks,
  completeTask,
  type Database,
  type EnqueueTaskResult,
  enqueueTask,
  extendLease,
  type ScheduledTaskRow,
  scheduledTasks,
  type TaskExecutor,
  type TaskLease,
  type TaskOutcome,
  taskLease,
} from "@loomcast/db";
import { count } from "drizzle-orm";
import type { EventBus } from "../../lib/bus";
import type { Clock } from "../../lib/clock";
import { afterCommit, type Executor, transaction } from "../../lib/db";
import type { Logger } from "../../lib/logger";

// The scheduler runs server-side tasks at a set time. Modules register a handler per task kind;
// the loop claims due tasks with `FOR UPDATE SKIP LOCKED`, so any number of API processes can run
// it and each task runs once. A handler gets an `AbortSignal` that fires when its lease is lost or
// the server stops, and its lease is renewed every `leaseMs / 2` while it runs.

/** Most tasks claimed by one tick. */
export const SCHEDULER_CLAIM_BATCH = 10;

/** Most tasks this process runs at the same time. */
export const SCHEDULER_MAX_IN_FLIGHT = 10;

/**
 * Lease taken by the claim itself. Each task's lease is set to its kind's `leaseMs` right after,
 * before its handler starts.
 */
export const SCHEDULER_CLAIM_LEASE_MS = 60_000;

/** How long `stop` waits for running handlers before aborting them. */
export const SCHEDULER_STOP_TIMEOUT_MS = 20_000;

/** After aborting, how long `stop` waits for handlers to record their outcome. */
const STOP_GRACE_MS = 2_000;

/** A tick older than this many tick intervals (and at least a minute) marks the loop stalled. */
const STALLED_AFTER_TICKS = 6;
const STALLED_MIN_MS = 60_000;

/**
 * Tasks that run on a fixed interval. The scheduler keeps one task of each kind queued under the
 * dedupe key `recurring:<kind>` (on start and every interval after), and after each successful run
 * enqueues the next one. It does so only for kinds with a registered handler.
 */
export const RECURRING_TASKS: Readonly<Partial<Record<ScheduledTaskKind, number>>> = {
  "cadence.plan": RECURRING_TASK_INTERVAL_MS,
  "assets.cleanup": RECURRING_TASK_INTERVAL_MS,
};

/** Dedupe key of the recurring task of `kind`. */
export function recurringDedupeKey(kind: ScheduledTaskKind): string {
  return `recurring:${kind}`;
}

/** What a handler receives for one run. */
export interface TaskContext<K extends ScheduledTaskKind> {
  task: ScheduledTaskRow;
  /** The payload, validated against the kind's registry schema. */
  payload: ScheduledTaskPayload<K>;
  /** Run number, 1 for the first. */
  attempt: number;
  /**
   * Aborted when the run must stop: its lease was lost (another instance may take the task over)
   * or the server is shutting down. Pass it to every request the handler makes.
   */
  signal: AbortSignal;
  logger: Logger;
  /** The scheduler's clock. */
  now(): Date;
}

/**
 * What a successful run may return. `next` schedules the same kind again at that time, under the
 * same dedupe key, with `payload` (default: the same payload) and a fresh set of attempts. The
 * completion and the new task are written in one transaction.
 */
export interface TaskResult<K extends ScheduledTaskKind = ScheduledTaskKind> {
  next?: Date;
  payload?: ScheduledTaskPayload<K>;
}

export type TaskHandler<K extends ScheduledTaskKind> = (
  context: TaskContext<K>,
  // biome-ignore lint/suspicious/noConfusingVoidType: handlers without a result return nothing.
) => Promise<TaskResult<K> | void>;

/**
 * A failure a handler throws on purpose. `retryable: false` ends the task as `failed` at once;
 * otherwise it is retried with backoff (or after `retryAfterMs`) until its attempts run out, then
 * it is `dead`. `message` is stored on the task and shown to admins: never put secrets in it.
 * Any other error counts as retryable and is stored as `handler_error` with a generic message.
 */
export class TaskFailure extends Error {
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;

  constructor(
    readonly code: string,
    message: string,
    options: { retryable?: boolean; retryAfterMs?: number } = {},
  ) {
    super(message);
    this.name = "TaskFailure";
    this.retryable = options.retryable ?? true;
    this.retryAfterMs = options.retryAfterMs;
  }
}

export interface RegisterTaskOptions {
  /** Overrides the registry's `leaseMs` for this kind. Tests use short leases. */
  leaseMs?: number;
}

export interface EnqueueOptions {
  /** Defaults to now. */
  runAt?: Date;
  dedupeKey?: string | null;
  /** See `enqueueTask`: `reschedule` (default) or `keep`. */
  onDuplicate?: "reschedule" | "keep";
}

export type SchedulerHealthStatus = "ok" | "stalled" | "disabled" | "stopped";

/** For the readiness registry and the ops status page. */
export interface SchedulerHealth {
  status: SchedulerHealthStatus;
  workerId: string;
  /** True while the loop runs in this process. */
  running: boolean;
  lastTickAt: string | null;
  /**
   * Message of the last tick that failed, cleared by the next good one. The status turns
   * `stalled` when no tick has succeeded for six intervals (at least a minute).
   */
  lastTickError: string | null;
  inFlight: number;
  registeredKinds: ScheduledTaskKind[];
}

export interface Scheduler {
  /** Unique per process; stored as `scheduled_tasks.locked_by` on claimed tasks. */
  readonly workerId: string;
  /**
   * Registers the handler of `kind`. One handler per kind; call it from a module's `register`,
   * before the loop starts.
   */
  register<K extends ScheduledTaskKind>(
    kind: K,
    handler: TaskHandler<K>,
    options?: RegisterTaskOptions,
  ): void;
  hasHandler(kind: ScheduledTaskKind): boolean;
  /**
   * Inserts a pending task. Pass a transaction first to enqueue atomically with the change that
   * needs the task. The payload is validated against the registry (throws on a bad one); it holds
   * ids only, never secrets. A task due before the next tick wakes the loop after the commit.
   */
  enqueue<K extends ScheduledTaskKind>(
    kind: K,
    payload: ScheduledTaskPayload<K>,
    options?: EnqueueOptions,
  ): Promise<EnqueueTaskResult>;
  enqueue<K extends ScheduledTaskKind>(
    executor: Executor,
    kind: K,
    payload: ScheduledTaskPayload<K>,
    options?: EnqueueOptions,
  ): Promise<EnqueueTaskResult>;
  /** Makes sure every recurring kind with a handler has a task queued. */
  ensureRecurring(): Promise<void>;
  /**
   * Claims due tasks (up to the free capacity, at most 10) and starts their handlers; reports dead
   * letters. Returns the number of tasks claimed. Handlers keep running after it resolves; await
   * `idle()` for them.
   */
  tick(): Promise<number>;
  /** Resolves once no handler of this process is running. */
  idle(): Promise<void>;
  /** Runs the loop every `tickMs` until `stop`. */
  start(): void;
  /** Asks a running loop to tick as soon as possible. */
  wake(): void;
  /**
   * Stops claiming, waits up to `timeoutMs` for running handlers, then aborts the rest and puts
   * their tasks back to `pending` so another instance picks them up.
   */
  stop(timeoutMs?: number): Promise<void>;
  health(): SchedulerHealth;
  /** Number of tasks per status, for the ops page. */
  queueDepths(): Promise<Record<TaskStatus, number>>;
}

export interface SchedulerDeps {
  db: Database;
  bus: EventBus;
  clock: Clock;
  logger: Logger;
  config: { enabled: boolean; tickMs: number };
  /** Defaults to `<host>:<pid>:<random>`. */
  workerId?: string;
  /** Jitter source of the retry backoff; tests pass a fixed one. */
  random?: () => number;
}

interface Registration {
  handler: TaskHandler<ScheduledTaskKind>;
  leaseMs: number | undefined;
}

interface InFlightRun {
  task: ScheduledTaskRow;
  lease: TaskLease;
  controller: AbortController;
  done: Promise<void>;
}

/** Why a run's signal fired. */
class RunAborted extends Error {
  constructor(readonly reason: "lease_lost" | "shutdown") {
    super(reason === "lease_lost" ? "The task lease was lost" : "The server is shutting down");
    this.name = "RunAborted";
  }
}

const MAX_ERROR_MESSAGE_LENGTH = 2_000;

function defaultWorkerId(): string {
  return `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

function isExecutor(value: unknown): value is Executor {
  return typeof value === "object" && value !== null;
}

export function createScheduler(deps: SchedulerDeps): Scheduler {
  const { db, clock, logger, config } = deps;
  const workerId = deps.workerId ?? defaultWorkerId();
  const random = deps.random ?? Math.random;
  const registrations = new Map<ScheduledTaskKind, Registration>();
  const inFlight = new Map<string, InFlightRun>();

  let running = false;
  let stopping = false;
  let timer: NodeJS.Timeout | null = null;
  let ticking: Promise<number> | null = null;
  let wakeRequested = false;
  let startedAt: Date | null = null;
  let lastTickAt: Date | null = null;
  let lastTickError: string | null = null;
  let lastEnsuredAt: number | null = null;

  function taskError(code: string, message: string): TaskError {
    return {
      code: code.slice(0, 64),
      message: message.slice(0, MAX_ERROR_MESSAGE_LENGTH),
      at: clock.now().toISOString(),
    };
  }

  /** The outcome of a failed run: retry with backoff, `failed`, or `dead` when out of attempts. */
  function failureOutcome(
    task: ScheduledTaskRow,
    error: unknown,
    log: Logger,
  ): Exclude<TaskOutcome, { status: "succeeded" }> {
    const kind = task.kind as ScheduledTaskKind;
    const backoffBaseMs = scheduledTaskRegistry[kind]?.backoffBaseMs ?? 60_000;
    let failure: TaskError;
    let retryable = true;
    let retryAfterMs: number | undefined;
    if (error instanceof RunAborted) {
      failure = taskError(
        error.reason === "shutdown" ? "interrupted" : "lease_lost",
        error.message,
      );
      // An interrupted run did not fail on its own: run it again straight away.
      retryAfterMs = 0;
    } else if (error instanceof TaskFailure) {
      failure = taskError(error.code, error.message);
      retryable = error.retryable;
      retryAfterMs = error.retryAfterMs;
      log.warn({ code: error.code, retryable }, "scheduled task failed");
    } else {
      failure = taskError(
        "handler_error",
        "The task failed unexpectedly; the server log has the details.",
      );
      log.error({ err: error }, "scheduled task threw");
    }
    if (!retryable) {
      return { status: "failed", error: failure };
    }
    if (task.attempts >= task.maxAttempts) {
      return { status: "dead", error: failure };
    }
    const delayMs = retryAfterMs ?? taskRetryDelayMs(backoffBaseMs, task.attempts, random);
    return {
      status: "pending",
      runAt: new Date(clock.now().getTime() + Math.max(0, delayMs)),
      error: failure,
    };
  }

  function isRecurringRun(task: ScheduledTaskRow): boolean {
    const kind = task.kind as ScheduledTaskKind;
    return RECURRING_TASKS[kind] !== undefined && task.dedupeKey === recurringDedupeKey(kind);
  }

  /** Records a run's outcome. Returns the updated task, or null when the lease was lost. */
  async function finish(
    task: ScheduledTaskRow,
    lease: TaskLease,
    result: { ok: true; value: TaskResult | undefined } | { ok: false; error: unknown },
    log: Logger,
  ): Promise<void> {
    const now = clock.now();
    const leaseAt = { ...lease, now };
    if (result.ok) {
      const kind = task.kind as ScheduledTaskKind;
      const interval = RECURRING_TASKS[kind];
      const next =
        result.value?.next ??
        (isRecurringRun(task) && interval !== undefined
          ? new Date(now.getTime() + interval)
          : undefined);
      if (next === undefined) {
        const row = await completeTask(db, leaseAt, { status: "succeeded" });
        if (row === null) {
          log.warn("task lease was lost before the run finished; its outcome is dropped");
        }
        return;
      }
      const payload = (result.value?.payload ?? task.payload) as JsonObject;
      const parsed = parseScheduledTaskPayload(kind, payload);
      if (!parsed.success) {
        throw new Error(`the next ${kind} payload is invalid`);
      }
      const nextTask = await transaction(db, async (tx) => {
        const row = await completeTask(tx, leaseAt, { status: "succeeded" });
        if (row === null) {
          return null;
        }
        const enqueued = await enqueueTask(tx, {
          kind,
          payload: parsed.data as JsonObject,
          runAt: next,
          maxAttempts: scheduledTaskRegistry[kind].maxAttempts,
          dedupeKey: task.dedupeKey,
          onDuplicate: "keep",
        });
        return enqueued.task;
      });
      if (nextTask === null) {
        log.warn("task lease was lost before the run finished; its outcome is dropped");
      } else {
        log.debug({ nextTaskId: nextTask.id, runAt: next.toISOString() }, "next run scheduled");
      }
      return;
    }

    const outcome = failureOutcome(task, result.error, log);
    const row = await completeTask(db, leaseAt, outcome);
    if (row === null) {
      log.warn("task lease was lost before the run finished; its outcome is dropped");
      return;
    }
    if (row.status === "dead" || row.status === "failed") {
      log.error({ status: row.status, code: row.lastError?.code }, "scheduled task gave up");
    }
  }

  /** Runs one claimed task to its outcome. Never rejects. */
  async function run(task: ScheduledTaskRow, controller: AbortController): Promise<void> {
    const lease = taskLease(task, workerId);
    const log = logger.child({ taskId: task.id, taskKind: task.kind, attempt: task.attempts });
    let renew: NodeJS.Timeout | null = null;
    try {
      const kind = task.kind;
      if (!isScheduledTaskKind(kind)) {
        await finish(
          task,
          lease,
          {
            ok: false,
            error: new TaskFailure("unknown_kind", `No task kind is named ${kind}`, {
              retryable: false,
            }),
          },
          log,
        );
        return;
      }
      const parsed = parseScheduledTaskPayload(kind, task.payload);
      if (!parsed.success) {
        await finish(
          task,
          lease,
          {
            ok: false,
            error: new TaskFailure("invalid_payload", "The task payload does not match its kind", {
              retryable: false,
            }),
          },
          log,
        );
        return;
      }
      const registration = registrations.get(kind);
      if (registration === undefined) {
        await finish(
          task,
          lease,
          {
            ok: false,
            error: new TaskFailure("no_handler", `This server has no handler for ${kind}`),
          },
          log,
        );
        return;
      }

      const leaseMs = registration.leaseMs ?? scheduledTaskRegistry[kind].leaseMs;
      const renewLease = async (): Promise<void> => {
        if (controller.signal.aborted) {
          return;
        }
        try {
          const until = await extendLease(db, { ...lease, leaseMs, now: clock.now() });
          if (until === null) {
            controller.abort(new RunAborted("lease_lost"));
          }
        } catch (error) {
          log.warn({ err: error }, "could not renew a task lease");
        }
      };
      await renewLease();
      if (controller.signal.aborted) {
        log.warn("task lease was lost before the run started");
        return;
      }
      renew = setInterval(() => void renewLease(), Math.max(1, Math.floor(leaseMs / 2)));
      renew.unref();

      const aborted = new Promise<never>((_, reject) => {
        const onAbort = () => reject(controller.signal.reason);
        if (controller.signal.aborted) {
          onAbort();
        } else {
          controller.signal.addEventListener("abort", onAbort, { once: true });
        }
      });
      aborted.catch(() => {});
      const handled = registration.handler({
        task,
        payload: parsed.data,
        attempt: task.attempts,
        signal: controller.signal,
        logger: log,
        now: () => clock.now(),
      });
      // A handler that ignores its signal keeps running, but its task is released at once.
      handled.catch(() => {});
      let result: { ok: true; value: TaskResult | undefined } | { ok: false; error: unknown };
      try {
        const value = await Promise.race([handled, aborted]);
        result = { ok: true, value: value ?? undefined };
      } catch (error) {
        result = {
          ok: false,
          error: controller.signal.aborted ? (controller.signal.reason ?? error) : error,
        };
      }
      clearInterval(renew);
      renew = null;
      if (
        !result.ok &&
        result.error instanceof RunAborted &&
        result.error.reason === "lease_lost"
      ) {
        log.warn("task lease was lost; another instance may run it");
        return;
      }
      await finish(task, lease, result, log);
    } catch (error) {
      log.error({ err: error }, "could not record a task outcome");
    } finally {
      if (renew !== null) {
        clearInterval(renew);
      }
    }
  }

  function launch(task: ScheduledTaskRow): void {
    const controller = new AbortController();
    const entry: InFlightRun = {
      task,
      lease: taskLease(task, workerId),
      controller,
      done: Promise.resolve(),
    };
    inFlight.set(task.id, entry);
    entry.done = run(task, controller).finally(() => {
      inFlight.delete(task.id);
    });
  }

  async function claimAndLaunch(): Promise<number> {
    const capacity = SCHEDULER_MAX_IN_FLIGHT - inFlight.size;
    if (stopping || capacity <= 0) {
      return 0;
    }
    const { claimed, deadLettered } = await claimDueTasks(db, {
      limit: Math.min(SCHEDULER_CLAIM_BATCH, capacity),
      workerId,
      leaseMs: SCHEDULER_CLAIM_LEASE_MS,
      now: clock.now(),
    });
    for (const task of claimed) {
      launch(task);
    }
    for (const task of deadLettered) {
      logger.error({ taskId: task.id, taskKind: task.kind }, "task dead-lettered at claim");
    }
    return claimed.length;
  }

  function tick(): Promise<number> {
    ticking ??= claimAndLaunch()
      .then(
        (claimed) => {
          lastTickAt = clock.now();
          lastTickError = null;
          return claimed;
        },
        (error: unknown) => {
          lastTickError = error instanceof Error ? error.message : String(error);
          throw error;
        },
      )
      .finally(() => {
        ticking = null;
      });
    return ticking;
  }

  async function ensureRecurring(): Promise<void> {
    for (const [kind, interval] of Object.entries(RECURRING_TASKS) as [
      ScheduledTaskKind,
      number,
    ][]) {
      if (!registrations.has(kind) || interval <= 0) {
        continue;
      }
      await enqueueTask(db, {
        kind,
        payload: {},
        runAt: clock.now(),
        maxAttempts: scheduledTaskRegistry[kind].maxAttempts,
        dedupeKey: recurringDedupeKey(kind),
        onDuplicate: "keep",
      });
    }
    lastEnsuredAt = Date.now();
  }

  function schedule(ms: number): void {
    if (!running || stopping) {
      return;
    }
    if (timer !== null) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = null;
      void loop();
    }, ms);
    timer.unref();
  }

  async function loop(): Promise<void> {
    let claimed = 0;
    try {
      if (lastEnsuredAt === null || Date.now() - lastEnsuredAt >= RECURRING_TASK_INTERVAL_MS) {
        await ensureRecurring();
      }
      claimed = await tick();
    } catch (error) {
      logger.error({ err: error }, "scheduler tick failed");
    }
    const again = wakeRequested || claimed >= SCHEDULER_CLAIM_BATCH;
    wakeRequested = false;
    schedule(again ? 0 : config.tickMs);
  }

  async function enqueue<K extends ScheduledTaskKind>(
    ...args:
      | [K, ScheduledTaskPayload<K>, EnqueueOptions?]
      | [Executor, K, ScheduledTaskPayload<K>, EnqueueOptions?]
  ): Promise<EnqueueTaskResult> {
    const [executor, kind, payload, options = {}] = isExecutor(args[0])
      ? (args as [Executor, K, ScheduledTaskPayload<K>, EnqueueOptions?])
      : ([db, ...args] as [Executor, K, ScheduledTaskPayload<K>, EnqueueOptions?]);
    const parsed = parseScheduledTaskPayload(kind, payload);
    if (!parsed.success) {
      throw new Error(`invalid payload for scheduled task ${kind}: ${parsed.error.message}`);
    }
    const runAt = options.runAt ?? clock.now();
    const result = await enqueueTask(executor as TaskExecutor, {
      kind,
      payload: parsed.data as JsonObject,
      runAt,
      maxAttempts: scheduledTaskRegistry[kind].maxAttempts,
      dedupeKey: options.dedupeKey ?? null,
      onDuplicate: options.onDuplicate,
    });
    if (runAt.getTime() <= clock.now().getTime() + config.tickMs) {
      afterCommit(executor, () => scheduler.wake());
    }
    return result;
  }

  const scheduler: Scheduler = {
    workerId,

    register(kind, handler, options = {}) {
      if (registrations.has(kind)) {
        throw new Error(`a handler for ${kind} is already registered`);
      }
      registrations.set(kind, {
        handler: handler as unknown as TaskHandler<ScheduledTaskKind>,
        leaseMs: options.leaseMs,
      });
    },

    hasHandler: (kind) => registrations.has(kind),

    enqueue: enqueue as Scheduler["enqueue"],

    ensureRecurring,

    tick,

    async idle() {
      while (inFlight.size > 0) {
        await Promise.all([...inFlight.values()].map((entry) => entry.done));
      }
    },

    start() {
      if (running || stopping) {
        return;
      }
      running = true;
      startedAt = clock.now();
      logger.info({ workerId, tickMs: config.tickMs }, "scheduler started");
      schedule(0);
    },

    wake() {
      if (!running || stopping) {
        return;
      }
      if (ticking !== null || timer === null) {
        wakeRequested = true;
        return;
      }
      schedule(0);
    },

    async stop(timeoutMs = SCHEDULER_STOP_TIMEOUT_MS) {
      if (stopping) {
        return;
      }
      stopping = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      await ticking?.catch(() => 0);
      const all = () => Promise.all([...inFlight.values()].map((entry) => entry.done));
      if (inFlight.size > 0) {
        logger.info({ running: inFlight.size }, "waiting for scheduled tasks to finish");
        await Promise.race([all(), delay(timeoutMs)]);
      }
      if (inFlight.size > 0) {
        logger.warn({ running: inFlight.size }, "aborting scheduled tasks that did not finish");
        for (const entry of inFlight.values()) {
          entry.controller.abort(new RunAborted("shutdown"));
        }
        await Promise.race([all(), delay(STOP_GRACE_MS)]);
      }
      if (running) {
        logger.info("scheduler stopped");
      }
      running = false;
    },

    health() {
      let status: SchedulerHealthStatus;
      if (!config.enabled) {
        status = "disabled";
      } else if (!running) {
        status = "stopped";
      } else {
        const stalledAfter = Math.max(STALLED_AFTER_TICKS * config.tickMs, STALLED_MIN_MS);
        const last = (lastTickAt ?? startedAt ?? clock.now()).getTime();
        status = clock.now().getTime() - last > stalledAfter ? "stalled" : "ok";
      }
      return {
        status,
        workerId,
        running,
        lastTickAt: lastTickAt?.toISOString() ?? null,
        lastTickError,
        inFlight: inFlight.size,
        registeredKinds: [...registrations.keys()],
      };
    },

    async queueDepths() {
      const rows = await db
        .select({ status: scheduledTasks.status, count: count() })
        .from(scheduledTasks)
        .groupBy(scheduledTasks.status);
      const depths = Object.fromEntries(TASK_STATUSES.map((status) => [status, 0])) as Record<
        TaskStatus,
        number
      >;
      for (const row of rows) {
        depths[row.status] = Number(row.count);
      }
      return depths;
    },
  };

  return scheduler;
}
