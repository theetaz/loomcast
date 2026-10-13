import {
  CONCURRENCY_CLASSES,
  type ConcurrencyClass,
  type Credits,
  getJobDefinition,
  type JobType,
} from "@loomcast/contracts";
import { type Database, devices, type JobRow, jobs } from "@loomcast/db";
import { and, asc, eq, inArray, isNull, notInArray, or, sql } from "drizzle-orm";
import type { EventBus } from "../../lib/bus";
import type { Clock } from "../../lib/clock";
import { afterCommit, transaction } from "../../lib/db";
import type { Logger } from "../../lib/logger";
import type { JobLifecycle } from "./lifecycle";
import { toJobSummary } from "./service";
import { statusesAllowing } from "./transitions";

/** What one studio agent can take right now. */
export interface DispatchTarget {
  deviceId: string;
  /** Job types the agent advertised in `hello`. */
  jobTypes: readonly JobType[];
  /** Free slots per concurrency class, net of jobs already sent and not yet answered. */
  credits: Credits;
  /** Jobs this agent must not get now, for example ones it is still stopping. */
  exclude?: readonly string[];
}

/** A connected studio agent as the dispatcher sees it. */
export interface DispatchSession {
  readonly deviceId: string;
  /** Null while the session cannot take jobs (before `hello`, or closing). */
  target(): DispatchTarget | null;
  /** Sends `job.assign`. False when the socket is gone; the job then goes back to the queue. */
  assign(job: JobRow): boolean;
}

export interface Dispatcher {
  /**
   * Claims queued jobs for one agent in a single transaction: `FOR UPDATE SKIP LOCKED` filtered by
   * its job types and device affinity, at most its credits per concurrency class, oldest first.
   * The claimed jobs are `dispatched` to the device, with the attempt counted.
   */
  claim(target: DispatchTarget): Promise<JobRow[]>;
  /** Asks for a dispatch round. Calls while a round runs are folded into one more round. */
  trigger(): void;
  /** Runs dispatch rounds until no trigger is pending. */
  run(): Promise<void>;
  /** Resolves once the current round, if any, has finished. */
  idle(): Promise<void>;
}

export interface DispatcherDeps {
  db: Database;
  bus: EventBus;
  clock: Clock;
  logger: Logger;
  lifecycle: JobLifecycle;
  /** The connected agents of this process. */
  sessions(): Iterable<DispatchSession>;
}

/** Job types per concurrency class, from the registry. */
function typesByClass(types: readonly JobType[]): Map<ConcurrencyClass, JobType[]> {
  const result = new Map<ConcurrencyClass, JobType[]>();
  for (const type of types) {
    const cls = getJobDefinition(type).concurrencyClass;
    result.set(cls, [...(result.get(cls) ?? []), type]);
  }
  return result;
}

export function createDispatcher(deps: DispatcherDeps): Dispatcher {
  const { db, bus, clock, logger, lifecycle } = deps;
  let running: Promise<void> | null = null;
  let pending = false;
  let rotation = 0;

  async function claim(target: DispatchTarget): Promise<JobRow[]> {
    const byClass = typesByClass(target.jobTypes);
    const wanted = CONCURRENCY_CLASSES.filter(
      (cls) => target.credits[cls] > 0 && (byClass.get(cls)?.length ?? 0) > 0,
    );
    if (wanted.length === 0) {
      return [];
    }
    return transaction(db, async (tx) => {
      const claimed: JobRow[] = [];
      for (const cls of wanted) {
        const exclude = target.exclude ?? [];
        const candidates = await tx
          .select({ id: jobs.id })
          .from(jobs)
          .where(
            and(
              eq(jobs.status, "queued"),
              inArray(jobs.type, byClass.get(cls) ?? []),
              isNull(jobs.cancelRequestedAt),
              or(
                isNull(jobs.deviceAffinity),
                eq(jobs.deviceAffinity, target.deviceId),
                // Affinity to a revoked device can never be honoured; any agent may take the job.
                sql`exists (select 1 from ${devices} where ${devices.id} = ${jobs.deviceAffinity} and ${devices.revokedAt} is not null)`,
              ),
              exclude.length === 0 ? undefined : notInArray(jobs.id, [...exclude]),
            ),
          )
          .orderBy(asc(jobs.createdAt), asc(jobs.id))
          .limit(target.credits[cls])
          .for("update", { of: jobs, skipLocked: true });
        if (candidates.length === 0) {
          continue;
        }
        const rows = await tx
          .update(jobs)
          .set({
            status: "dispatched",
            claimedByDevice: target.deviceId,
            dispatchedAt: clock.now(),
            startedAt: null,
            leaseExpiresAt: null,
            attempt: sql`${jobs.attempt} + 1`,
          })
          .where(
            and(
              inArray(
                jobs.id,
                candidates.map((row) => row.id),
              ),
              inArray(jobs.status, statusesAllowing("dispatch")),
            ),
          )
          .returning();
        rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
        claimed.push(...rows);
      }
      for (const row of claimed) {
        const job = toJobSummary(row);
        afterCommit(tx, () => bus.publish({ type: "job.updated", payload: { job } }));
      }
      return claimed;
    });
  }

  async function dispatchTo(session: DispatchSession): Promise<void> {
    const target = session.target();
    if (target === null) {
      return;
    }
    const rows = await claim(target);
    for (const row of rows) {
      if (!session.assign(row)) {
        logger.info({ jobId: row.id, deviceId: row.claimedByDevice }, "assignment not delivered");
        await lifecycle.requeueDispatched(target.deviceId, row.id);
      }
    }
  }

  async function round(): Promise<void> {
    const sessions = [...deps.sessions()];
    if (sessions.length === 0) {
      return;
    }
    // Start with a different agent each round so no device always gets the oldest jobs first.
    rotation = (rotation + 1) % sessions.length;
    const ordered = [...sessions.slice(rotation), ...sessions.slice(0, rotation)];
    for (const session of ordered) {
      try {
        await dispatchTo(session);
      } catch (error) {
        logger.error({ err: error, deviceId: session.deviceId }, "dispatch failed");
      }
    }
  }

  function run(): Promise<void> {
    pending = true;
    running ??= (async () => {
      try {
        while (pending) {
          pending = false;
          await round();
        }
      } finally {
        running = null;
      }
    })();
    return running;
  }

  return {
    claim,
    trigger() {
      run().catch((error: unknown) => logger.error({ err: error }, "dispatch round failed"));
    },
    run,
    async idle() {
      while (running !== null) {
        await running;
      }
    },
  };
}
