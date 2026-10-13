import {
  allowsEventKind,
  getJobDefinition,
  type JobError,
  type JobEvent,
  type JsonObject,
  parseJobResult,
  type ResumeEntry,
} from "@loomcast/contracts";
import { type Database, type JobRow, jobEvents, jobs, type NewJobRow } from "@loomcast/db";
import { and, eq, inArray, lt, notInArray } from "drizzle-orm";
import type { EventBus } from "../../lib/bus";
import type { Clock } from "../../lib/clock";
import { afterCommit, type Transaction, transaction } from "../../lib/db";
import { createProducerChatHooks } from "./handlers/producer-chat";
import type { JobHooks } from "./hooks";
import { toJobSummary } from "./service";
import { type JobAction, nextStatus, statusesAllowing } from "./transitions";

export const CANCELLED_ERROR: JobError = {
  code: "cancelled",
  message: "The job was cancelled.",
  retryable: false,
};

export const INTERRUPTED_ERROR: JobError = {
  code: "interrupted",
  message: "The studio agent stopped reporting before the job finished.",
  retryable: true,
};

/** Most expired or unaccepted jobs handled per sweep; the next sweep takes the rest. */
const SWEEP_BATCH = 100;

/** Reject reasons that no other attempt can fix: the job fails instead of going back to the queue. */
function isPermanentRejection(reason: string | undefined): boolean {
  return (
    reason !== undefined &&
    (reason.startsWith("invalid_payload") || reason.startsWith("invalid_assignment"))
  );
}

export interface LifecycleDeps {
  db: Database;
  bus: EventBus;
  clock: Clock;
  /** Per-type side effects. Defaults to the built-in hooks (`producer.chat`). */
  hooks?: JobHooks;
}

export function defaultJobHooks(deps: { bus: EventBus }): JobHooks {
  return { "producer.chat": createProducerChatHooks(deps) };
}

export type AcceptOutcome =
  /** `dispatched` → `running`. */
  | "started"
  /** Already running on this device: the lease was extended. */
  | "confirmed"
  /** Not this device's job, or no longer dispatched or running: the agent should stop it. */
  | "stale";

export interface EventOutcome {
  /** The job exists and is claimed by the sending device. */
  owned: boolean;
  /** The event was stored now (false for a replay or an event that was not stored). */
  stored: boolean;
  /** The job type may not emit this event kind; it was not stored. */
  invalidKind: boolean;
  job: JobRow | null;
}

export interface OutcomeResult {
  /** The job changed; false for a duplicate or late outcome, which is ignored. */
  applied: boolean;
  job: JobRow | null;
}

export interface ResumeResult {
  /** Jobs that continue on this device. */
  kept: JobRow[];
  /** Jobs the agent should stop: not its job any more, finished, or cancelled by a user. */
  cancel: string[];
  /** Dispatched jobs the agent did not know about; they went back to the queue. */
  requeued: JobRow[];
}

export interface SweptJob {
  job: JobRow;
  /** The studio agent that held the job before the sweep. */
  previousDevice: string | null;
}

export interface CancelResult {
  job: JobRow;
  /** False when the job had already finished or a cancel was already requested. */
  changed: boolean;
}

/**
 * Every status change of a job, each in its own transaction. A change is decided by
 * `nextStatus`, applied to the row locked with `FOR UPDATE`, and published as `job.updated` once
 * it commits. Messages about a job are only acted on when they come from the device that claimed
 * it, so a superseded or stale agent can never change another device's job.
 */
export interface JobLifecycle {
  accept(
    deviceId: string,
    jobId: string,
    leaseMs: number,
  ): Promise<{ outcome: AcceptOutcome; job: JobRow | null }>;
  /** Stores a durable event once (`ON CONFLICT DO NOTHING`) and runs the type's hooks. */
  recordEvent(deviceId: string, event: JobEvent, leaseMs: number): Promise<EventOutcome>;
  /** Extends the leases of this device's running jobs; returns the ids it extended. */
  heartbeat(deviceId: string, jobIds: readonly string[], leaseMs: number): Promise<string[]>;
  complete(deviceId: string, jobId: string, result: JsonObject): Promise<OutcomeResult>;
  fail(deviceId: string, jobId: string, error: JobError): Promise<OutcomeResult>;
  reject(deviceId: string, jobId: string, reason: string | undefined): Promise<OutcomeResult>;
  /** Applies a `hello.resume` list (see `ResumeResult`). */
  resume(deviceId: string, entries: readonly ResumeEntry[], leaseMs: number): Promise<ResumeResult>;
  /** Puts a dispatched job back in the queue, for an assignment that could not be sent. */
  requeueDispatched(deviceId: string, jobId: string): Promise<JobRow | null>;
  /** Re-queues jobs dispatched before `before` and still not accepted. */
  requeueUnaccepted(before: Date): Promise<SweptJob[]>;
  /** Applies the registry's lease-expiry policy to running jobs whose lease has passed. */
  expireLeases(): Promise<SweptJob[]>;
  /**
   * Cancels a queued job at once; for a dispatched or running job, records the request (the bridge
   * then sends `job.cancel`). Null when there is no such job.
   */
  requestCancel(jobId: string): Promise<CancelResult | null>;
}

export function createJobLifecycle(deps: LifecycleDeps): JobLifecycle {
  const { db, bus, clock } = deps;
  const hooks = deps.hooks ?? defaultJobHooks(deps);

  const leaseUntil = (leaseMs: number) => new Date(clock.now().getTime() + leaseMs);

  function publishUpdated(tx: Transaction, row: JobRow): void {
    const job = toJobSummary(row);
    afterCommit(tx, () => bus.publish({ type: "job.updated", payload: { job } }));
  }

  async function lock(tx: Transaction, jobId: string): Promise<JobRow | null> {
    const [row] = await tx.select().from(jobs).where(eq(jobs.id, jobId)).limit(1).for("update");
    return row ?? null;
  }

  /**
   * Moves a locked job with `action`. Returns null (and changes nothing) when the pure transition
   * function does not allow it from the job's current status.
   */
  async function apply(
    tx: Transaction,
    job: JobRow,
    action: JobAction,
    values: Partial<NewJobRow>,
  ): Promise<JobRow | null> {
    const status = nextStatus(job.status, action);
    if (status === null) {
      return null;
    }
    const [row] = await tx
      .update(jobs)
      .set({ ...values, status })
      .where(and(eq(jobs.id, job.id), inArray(jobs.status, statusesAllowing(action))))
      .returning();
    if (row === undefined) {
      return null;
    }
    if (row.status !== job.status || row.cancelRequestedAt !== job.cancelRequestedAt) {
      publishUpdated(tx, row);
    }
    return row;
  }

  function finished(): Partial<NewJobRow> {
    return { finishedAt: clock.now(), leaseExpiresAt: null };
  }

  function cancel(tx: Transaction, job: JobRow): Promise<JobRow | null> {
    return apply(tx, job, "cancel", {
      ...finished(),
      error: CANCELLED_ERROR,
      cancelRequestedAt: job.cancelRequestedAt ?? clock.now(),
    });
  }

  function failWith(tx: Transaction, job: JobRow, error: JobError): Promise<JobRow | null> {
    return apply(tx, job, "fail", { ...finished(), error });
  }

  /**
   * Back to the queue, unclaimed. The job's durable events are deleted: the next attempt may run
   * on another studio agent, whose event sequence starts at 1 again, and stale events would
   * otherwise swallow the new ones through the `(job_id, seq)` unique index.
   */
  async function requeue(tx: Transaction, job: JobRow, attemptDelta = 0): Promise<JobRow | null> {
    const row = await apply(tx, job, "requeue", {
      claimedByDevice: null,
      dispatchedAt: null,
      startedAt: null,
      leaseExpiresAt: null,
      error: null,
      attempt: Math.max(0, job.attempt + attemptDelta),
    });
    if (row !== null) {
      await tx.delete(jobEvents).where(eq(jobEvents.jobId, job.id));
    }
    return row;
  }

  function owned(job: JobRow | null, deviceId: string): job is JobRow {
    return job !== null && job.claimedByDevice === deviceId;
  }

  return {
    accept(deviceId, jobId, leaseMs) {
      return transaction(db, async (tx) => {
        const job = await lock(tx, jobId);
        if (!owned(job, deviceId)) {
          return { outcome: "stale" as const, job };
        }
        if (job.status === "running") {
          const [row] = await tx
            .update(jobs)
            .set({ leaseExpiresAt: leaseUntil(leaseMs) })
            .where(eq(jobs.id, job.id))
            .returning();
          return { outcome: "confirmed" as const, job: row ?? job };
        }
        const row = await apply(tx, job, "accept", {
          startedAt: clock.now(),
          leaseExpiresAt: leaseUntil(leaseMs),
        });
        return row === null
          ? { outcome: "stale" as const, job }
          : { outcome: "started" as const, job: row };
      });
    },

    recordEvent(deviceId, event, leaseMs) {
      return transaction(db, async (tx) => {
        const [job] = await tx.select().from(jobs).where(eq(jobs.id, event.jobId)).limit(1);
        if (job === undefined || job.claimedByDevice !== deviceId) {
          return { owned: false, stored: false, invalidKind: false, job: job ?? null };
        }
        if (!allowsEventKind(job.type, event.kind)) {
          return { owned: true, stored: false, invalidKind: true, job };
        }
        const [inserted] = await tx
          .insert(jobEvents)
          .values({
            jobId: job.id,
            seq: event.seq,
            kind: event.kind,
            data: event.data as JsonObject,
          })
          .onConflictDoNothing({ target: [jobEvents.jobId, jobEvents.seq] })
          .returning({ id: jobEvents.id });
        if (inserted === undefined) {
          return { owned: true, stored: false, invalidKind: false, job };
        }
        if (job.status === "running") {
          await tx
            .update(jobs)
            .set({ leaseExpiresAt: leaseUntil(leaseMs) })
            .where(and(eq(jobs.id, job.id), eq(jobs.status, "running")));
        }
        await hooks[job.type]?.onEvent?.(tx, job, event);
        if (event.kind === "tool.activity") {
          const payload = { jobId: job.id, kind: event.data.tool, summary: event.data.summary };
          afterCommit(tx, () => bus.publish({ type: "job.activity", payload }));
        }
        return { owned: true, stored: true, invalidKind: false, job };
      });
    },

    async heartbeat(deviceId, jobIds, leaseMs) {
      if (jobIds.length === 0) {
        return [];
      }
      const rows = await db
        .update(jobs)
        .set({ leaseExpiresAt: leaseUntil(leaseMs) })
        .where(
          and(
            inArray(jobs.id, [...jobIds]),
            eq(jobs.claimedByDevice, deviceId),
            eq(jobs.status, "running"),
          ),
        )
        .returning({ id: jobs.id });
      return rows.map((row) => row.id);
    },

    complete(deviceId, jobId, result) {
      return transaction(db, async (tx) => {
        const job = await lock(tx, jobId);
        if (!owned(job, deviceId) || nextStatus(job.status, "complete") === null) {
          return { applied: false, job };
        }
        const parsed = parseJobResult(job.type, result);
        if (!parsed.success) {
          const row = await failWith(tx, job, {
            code: "invalid_result",
            message: "The studio agent returned a result that does not match the job type.",
            retryable: false,
          });
          return { applied: row !== null, job: row ?? job };
        }
        const data = parsed.data as JsonObject;
        const row = await apply(tx, job, "complete", { ...finished(), result: data, error: null });
        if (row !== null) {
          await hooks[row.type]?.onSucceeded?.(tx, row, data);
        }
        return { applied: row !== null, job: row ?? job };
      });
    },

    fail(deviceId, jobId, error) {
      return transaction(db, async (tx) => {
        const job = await lock(tx, jobId);
        if (!owned(job, deviceId) || nextStatus(job.status, "fail") === null) {
          return { applied: false, job };
        }
        let row: JobRow | null;
        if (job.cancelRequestedAt !== null && error.code === "cancelled") {
          row = await apply(tx, job, "cancel", { ...finished(), error });
        } else if (
          error.retryable &&
          job.cancelRequestedAt === null &&
          getJobDefinition(job.type).retry.onLeaseExpiry === "requeue" &&
          job.attempt < job.maxAttempts
        ) {
          row = await requeue(tx, job);
        } else {
          row = await failWith(tx, job, error);
        }
        return { applied: row !== null, job: row ?? job };
      });
    },

    reject(deviceId, jobId, reason) {
      return transaction(db, async (tx) => {
        const job = await lock(tx, jobId);
        if (!owned(job, deviceId) || job.status !== "dispatched") {
          return { applied: false, job };
        }
        let row: JobRow | null;
        if (job.cancelRequestedAt !== null) {
          row = await cancel(tx, job);
        } else if (isPermanentRejection(reason)) {
          row = await failWith(tx, job, {
            code: "invalid_payload",
            message: `The studio agent rejected the job: ${reason ?? "no reason given"}`.slice(
              0,
              2_000,
            ),
            retryable: false,
          });
        } else {
          // The agent never started this attempt, so it does not count.
          row = await requeue(tx, job, -1);
        }
        return { applied: row !== null, job: row ?? job };
      });
    },

    resume(deviceId, entries, leaseMs) {
      return transaction(db, async (tx) => {
        const ids = [...new Set(entries.map((entry) => entry.jobId))];
        const rows =
          ids.length === 0
            ? []
            : await tx
                .select()
                .from(jobs)
                .where(inArray(jobs.id, ids))
                .orderBy(jobs.id)
                .for("update");
        const byId = new Map(rows.map((row) => [row.id, row]));
        const kept: JobRow[] = [];
        const cancelIds: string[] = [];
        for (const id of ids) {
          const job = byId.get(id) ?? null;
          if (!owned(job, deviceId) || (job.status !== "dispatched" && job.status !== "running")) {
            cancelIds.push(id);
            continue;
          }
          const row = await apply(tx, job, "accept", {
            startedAt: job.startedAt ?? clock.now(),
            leaseExpiresAt: leaseUntil(leaseMs),
          });
          kept.push(row ?? job);
          if (job.cancelRequestedAt !== null) {
            cancelIds.push(id);
          }
        }

        // Dispatched to this device, but the agent does not know them: the assignment was lost
        // with the previous connection.
        const lost = await tx
          .select()
          .from(jobs)
          .where(
            and(
              eq(jobs.claimedByDevice, deviceId),
              eq(jobs.status, "dispatched"),
              ids.length === 0 ? undefined : notInArray(jobs.id, ids),
            ),
          )
          .orderBy(jobs.id)
          .for("update");
        const requeued: JobRow[] = [];
        for (const job of lost) {
          const row =
            job.cancelRequestedAt === null ? await requeue(tx, job) : await cancel(tx, job);
          if (row !== null) {
            requeued.push(row);
          }
        }
        return { kept, cancel: cancelIds, requeued };
      });
    },

    requeueDispatched(deviceId, jobId) {
      return transaction(db, async (tx) => {
        const job = await lock(tx, jobId);
        if (!owned(job, deviceId) || job.status !== "dispatched") {
          return null;
        }
        return job.cancelRequestedAt === null ? requeue(tx, job) : cancel(tx, job);
      });
    },

    requeueUnaccepted(before) {
      return transaction(db, async (tx) => {
        const stale = await tx
          .select()
          .from(jobs)
          .where(and(eq(jobs.status, "dispatched"), lt(jobs.dispatchedAt, before)))
          .orderBy(jobs.dispatchedAt)
          .limit(SWEEP_BATCH)
          .for("update", { skipLocked: true });
        const swept: SweptJob[] = [];
        for (const job of stale) {
          const row =
            job.cancelRequestedAt === null ? await requeue(tx, job) : await cancel(tx, job);
          if (row !== null) {
            swept.push({ job: row, previousDevice: job.claimedByDevice });
          }
        }
        return swept;
      });
    },

    expireLeases() {
      return transaction(db, async (tx) => {
        const expired = await tx
          .select()
          .from(jobs)
          .where(and(eq(jobs.status, "running"), lt(jobs.leaseExpiresAt, clock.now())))
          .orderBy(jobs.leaseExpiresAt)
          .limit(SWEEP_BATCH)
          .for("update", { skipLocked: true });
        const swept: SweptJob[] = [];
        for (const job of expired) {
          let row: JobRow | null;
          if (job.cancelRequestedAt !== null) {
            row = await cancel(tx, job);
          } else if (
            getJobDefinition(job.type).retry.onLeaseExpiry === "requeue" &&
            job.attempt < job.maxAttempts
          ) {
            row = await requeue(tx, job);
          } else {
            row = await failWith(tx, job, INTERRUPTED_ERROR);
          }
          if (row !== null) {
            swept.push({ job: row, previousDevice: job.claimedByDevice });
          }
        }
        return swept;
      });
    },

    requestCancel(jobId) {
      return transaction(db, async (tx) => {
        const job = await lock(tx, jobId);
        if (job === null) {
          return null;
        }
        if (job.status === "queued") {
          const row = await cancel(tx, job);
          return { job: row ?? job, changed: row !== null };
        }
        if (nextStatus(job.status, "cancel") === null || job.cancelRequestedAt !== null) {
          return { job, changed: false };
        }
        const [row] = await tx
          .update(jobs)
          .set({ cancelRequestedAt: clock.now() })
          .where(eq(jobs.id, job.id))
          .returning();
        if (row === undefined) {
          return { job, changed: false };
        }
        publishUpdated(tx, row);
        return { job: row, changed: true };
      });
    },
  };
}
