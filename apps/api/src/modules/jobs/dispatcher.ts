import {
  BRIDGE_TIMINGS,
  CONCURRENCY_CLASSES,
  type ConcurrencyClass,
  type Credits,
  getJobDefinition,
  type JobCredentials,
  type JobType,
  MCP_PATH,
} from "@loomcast/contracts";
import { type Database, devices, type JobRow, jobs } from "@loomcast/db";
import { and, asc, eq, inArray, isNull, notInArray, or, sql } from "drizzle-orm";
import type { EventBus } from "../../lib/bus";
import type { Clock } from "../../lib/clock";
import { afterCommit, type Transaction, transaction } from "../../lib/db";
import type { Logger } from "../../lib/logger";
import { createTokensService, type TokensService } from "../tokens/service";
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

/**
 * One claimed job and the credentials minted for this assignment. `credentials` is null when the
 * job type's `mcpAccess` is `none`. The secret lives only in memory, from the claim until the
 * `job.assign` frame is written; it is never logged or stored.
 */
export interface Assignment {
  job: JobRow;
  credentials: JobCredentials | null;
}

/** A connected studio agent as the dispatcher sees it. */
export interface DispatchSession {
  readonly deviceId: string;
  /** Null while the session cannot take jobs (before `hello`, or closing). */
  target(): DispatchTarget | null;
  /**
   * Sends `job.assign`, with `credentials` when there are any. False when the socket is gone; the
   * job then goes back to the queue, which revokes the credentials.
   */
  assign(job: JobRow, credentials: JobCredentials | null): boolean;
}

export interface Dispatcher {
  /**
   * Claims queued jobs for one agent in a single transaction: `FOR UPDATE SKIP LOCKED` filtered by
   * its job types and device affinity, at most its credits per concurrency class, oldest first.
   * The claimed jobs are `dispatched` to the device, with the attempt counted. A job whose type
   * has MCP access gets a fresh job token in the same transaction; any token left from an earlier
   * assignment is revoked first.
   */
  claim(target: DispatchTarget): Promise<Assignment[]>;
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
  /** The job lease; a job token lives for the job type's timeout plus one lease. */
  leaseMs?: number;
  /** Mints and revokes job tokens. Defaults to a tokens service on `db`. */
  tokens?: Pick<TokensService, "mintJobToken" | "revokeForJob">;
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
  const tokens = deps.tokens ?? createTokensService({ db, clock });
  const leaseMs = deps.leaseMs ?? BRIDGE_TIMINGS.leaseMs;
  let running: Promise<void> | null = null;
  let pending = false;
  let rotation = 0;

  /** Credentials for one assignment of `job`, or null when its type has no MCP access. */
  async function credentialsFor(tx: Transaction, job: JobRow): Promise<JobCredentials | null> {
    const definition = getJobDefinition(job.type);
    if (definition.mcpAccess === "none") {
      return null;
    }
    // A token of an earlier assignment never carries over to the next one.
    await tokens.revokeForJob(job.id, tx);
    const minted = await tokens.mintJobToken(
      {
        jobId: job.id,
        workspaceId: job.workspaceId,
        userId: job.createdBy,
        access: definition.mcpAccess,
        ttlMs: definition.timeoutMs + leaseMs,
      },
      tx,
    );
    return {
      mcp: { endpoint: MCP_PATH, token: minted.secret, expiresAt: minted.expiresAt.toISOString() },
    };
  }

  async function claim(target: DispatchTarget): Promise<Assignment[]> {
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
              // Compared as text: a type the agent knows but the job_type enum does not yet
              // (a newer agent before its migration) must match nothing rather than fail the claim.
              inArray(sql`${jobs.type}::text`, byClass.get(cls) ?? []),
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
      const assignments: Assignment[] = [];
      for (const row of claimed) {
        assignments.push({ job: row, credentials: await credentialsFor(tx, row) });
        const job = toJobSummary(row);
        afterCommit(tx, () => bus.publish({ type: "job.updated", payload: { job } }));
      }
      return assignments;
    });
  }

  async function dispatchTo(session: DispatchSession): Promise<void> {
    const target = session.target();
    if (target === null) {
      return;
    }
    const assignments = await claim(target);
    for (const { job, credentials } of assignments) {
      if (!session.assign(job, credentials)) {
        logger.info({ jobId: job.id, deviceId: job.claimedByDevice }, "assignment not delivered");
        // Re-queueing revokes the job token minted for this assignment.
        await lifecycle.requeueDispatched(target.deviceId, job.id);
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
