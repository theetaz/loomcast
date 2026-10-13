import type { JsonObject, ScheduledTaskKind, TaskError } from "@loomcast/contracts";
import { and, eq, getTableColumns, inArray, type SQL, sql } from "drizzle-orm";
import type { Database } from "../client";
import { type ScheduledTaskRow, scheduledTasks } from "../schema";

// The scheduler's task lifecycle. Every function takes the database or a transaction; pass a
// transaction to enqueue a task atomically with the change that needs it. All of them accept an
// optional `now` for tests with a fake clock; by default the database clock decides.

/** Anything with the query builders and raw queries: a transaction, or the database. */
export type TaskExecutor = Pick<Database, "execute" | "insert" | "select" | "update">;

/** The error code a task gets when it is dead-lettered by `claimDueTasks`. */
export const TASK_LEASE_EXPIRED_CODE = "lease_expired";
export const TASK_ATTEMPTS_EXHAUSTED_CODE = "attempts_exhausted";

const ACTIVE_TASK_STATUSES = ["pending", "running"] as const;

function at(now: Date | undefined): SQL {
  return now === undefined ? sql`now()` : sql`${now.toISOString()}::timestamptz`;
}

function plusMs(now: Date | undefined, ms: number): SQL {
  return sql`(${at(now)} + ${Math.max(0, Math.round(ms))}::bigint * interval '1 millisecond')`;
}

const COLUMNS = Object.entries(getTableColumns(scheduledTasks));

/** `select` list that maps every column of a `scheduled_tasks` row to its property name. */
const TASK_COLUMNS = sql.join(
  COLUMNS.map(([key, column]) => sql`${sql.identifier(column.name)} as ${sql.identifier(key)}`),
  sql`, `,
);

/**
 * Decodes a raw row selected with `TASK_COLUMNS`. Raw queries skip Drizzle's decoding (the driver
 * returns timestamps as text), so each value goes through its column's mapper, as a query builder
 * would do.
 */
function decodeTask(raw: Record<string, unknown>): ScheduledTaskRow {
  const row: Record<string, unknown> = {};
  for (const [key, column] of COLUMNS) {
    const value = raw[key];
    row[key] = value === null || value === undefined ? null : column.mapFromDriverValue(value);
  }
  return row as ScheduledTaskRow;
}

export interface EnqueueTaskInput {
  kind: ScheduledTaskKind;
  /** Validate it with `parseScheduledTaskPayload` first. Ids only, never secrets. */
  payload: JsonObject;
  /** Defaults to now. */
  runAt?: Date;
  /** From the kind's registry entry. */
  maxAttempts: number;
  /** At most one pending or running task holds a key. */
  dedupeKey?: string | null;
  /**
   * What happens when a pending or running task already holds `dedupeKey`:
   * - `reschedule` (default): a pending task takes the new `runAt`, `payload` and `maxAttempts`;
   *   a running one is left alone.
   * - `keep`: the existing task is left alone.
   * Either way the existing task is returned with `created: false`.
   */
  onDuplicate?: "reschedule" | "keep";
}

export interface EnqueueTaskResult {
  task: ScheduledTaskRow;
  /** False when a pending or running task already held the dedupe key. */
  created: boolean;
}

/**
 * Inserts a pending task. With a `dedupeKey` this is an upsert on `scheduled_tasks_dedupe_key_uq`:
 * see `onDuplicate`. A task that has finished no longer holds its key, so the same key can be
 * enqueued again afterwards.
 */
export async function enqueueTask(
  db: TaskExecutor,
  input: EnqueueTaskInput,
): Promise<EnqueueTaskResult> {
  const values = {
    kind: input.kind,
    payload: input.payload,
    maxAttempts: input.maxAttempts,
    dedupeKey: input.dedupeKey ?? null,
    ...(input.runAt === undefined ? {} : { runAt: input.runAt }),
  };
  const returning = { ...getTableColumns(scheduledTasks), created: sql<boolean>`(xmax = 0)` };

  if (values.dedupeKey === null) {
    const [task] = await db.insert(scheduledTasks).values(values).returning();
    if (task === undefined) throw new Error("the task was not inserted");
    return { task, created: true };
  }

  const activeKey = sql`${scheduledTasks.status} in ('pending', 'running')`;
  // A conflicting task can finish between the insert and the read that follows it; then the key
  // is free and the next round inserts.
  for (let round = 0; round < 3; round += 1) {
    const insert = db.insert(scheduledTasks).values(values);
    const rows =
      input.onDuplicate === "keep"
        ? await insert
            .onConflictDoNothing({ target: scheduledTasks.dedupeKey, where: activeKey })
            .returning(returning)
        : await insert
            .onConflictDoUpdate({
              target: scheduledTasks.dedupeKey,
              targetWhere: activeKey,
              set: {
                runAt: sql`excluded.run_at`,
                payload: sql`excluded.payload`,
                maxAttempts: sql`excluded.max_attempts`,
              },
              setWhere: sql`${scheduledTasks.status} = 'pending'`,
            })
            .returning(returning);
    const [row] = rows;
    if (row !== undefined) {
      const { created, ...task } = row;
      return { task, created };
    }
    const [existing] = await db
      .select()
      .from(scheduledTasks)
      .where(
        and(
          eq(scheduledTasks.dedupeKey, values.dedupeKey),
          inArray(scheduledTasks.status, [...ACTIVE_TASK_STATUSES]),
        ),
      );
    if (existing !== undefined) return { task: existing, created: false };
  }
  throw new Error(`could not enqueue the task with dedupe key ${values.dedupeKey}`);
}

export interface ClaimDueTasksOptions {
  /** Most tasks to take in this call, at least 1. */
  limit: number;
  /** The claiming scheduler instance, unique per process (for example host, pid and a random id). */
  workerId: string;
  /** How long the claim holds before another instance may take the task over. */
  leaseMs: number;
  now?: Date;
}

export interface ClaimDueTasksResult {
  /** Tasks now `running` under this worker's lease, oldest `runAt` first. */
  claimed: ScheduledTaskRow[];
  /**
   * Due tasks that had no attempt left, now `dead`: a run whose lease ran out (`lease_expired`) or,
   * defensively, a pending task already at `maxAttempts` (`attempts_exhausted`). Report them as
   * dead-lettered.
   */
  deadLettered: ScheduledTaskRow[];
}

/**
 * Claims due tasks in one statement: pending tasks whose `runAt` has come, and running tasks whose
 * lease ran out (their scheduler stopped or crashed). A CTE selects up to `limit` of them, oldest
 * `runAt` first, with `FOR UPDATE SKIP LOCKED`, so concurrent claimers never take the same task.
 * Each claimed task becomes `running` with `attempts + 1` and a lease of `leaseMs` for `workerId`.
 * A selected task with no attempt left becomes `dead` instead.
 *
 * Run it outside a long transaction: the row locks last until the surrounding transaction ends.
 */
export async function claimDueTasks(
  db: TaskExecutor,
  options: ClaimDueTasksOptions,
): Promise<ClaimDueTasksResult> {
  const now = at(options.now);
  const limit = Math.max(1, Math.floor(options.limit));
  const result = await db.execute<Record<string, unknown> & { outcome: "claimed" | "dead" }>(sql`
    with due as materialized (
      select id, attempts >= max_attempts as exhausted
      from scheduled_tasks
      where (status = 'pending' and run_at <= ${now})
         or (status = 'running' and locked_until < ${now})
      order by run_at, id
      limit ${limit}
      for update skip locked
    ),
    claimed as (
      update scheduled_tasks
      set status = 'running',
          attempts = scheduled_tasks.attempts + 1,
          locked_by = ${options.workerId},
          locked_until = ${plusMs(options.now, options.leaseMs)}
      from due
      where scheduled_tasks.id = due.id and not due.exhausted
      returning scheduled_tasks.*
    ),
    dead as (
      update scheduled_tasks
      set status = 'dead',
          locked_by = null,
          locked_until = null,
          finished_at = ${now},
          last_error = jsonb_build_object(
            'code', case when scheduled_tasks.status = 'running'
                      then ${TASK_LEASE_EXPIRED_CODE}::text else ${TASK_ATTEMPTS_EXHAUSTED_CODE}::text end,
            'message', case when scheduled_tasks.status = 'running'
                      then 'The last attempt stopped renewing its lease and no attempt is left'
                      else 'The task was due with no attempt left' end,
            'at', to_char(${now} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
      from due
      where scheduled_tasks.id = due.id and due.exhausted
      returning scheduled_tasks.*
    )
    select 'claimed' as outcome, ${TASK_COLUMNS} from claimed
    union all
    select 'dead' as outcome, ${TASK_COLUMNS} from dead
  `);
  const claimed: ScheduledTaskRow[] = [];
  const deadLettered: ScheduledTaskRow[] = [];
  for (const { outcome, ...raw } of result.rows) {
    (outcome === "claimed" ? claimed : deadLettered).push(decodeTask(raw));
  }
  const byRunAt = (a: ScheduledTaskRow, b: ScheduledTaskRow) =>
    a.runAt.getTime() - b.runAt.getTime() || a.id.localeCompare(b.id);
  claimed.sort(byRunAt);
  deadLettered.sort(byRunAt);
  return { claimed, deadLettered };
}

/** One run of a task: the task, the worker holding it, and its run number (`attempts` at claim). */
export interface TaskLease {
  id: string;
  workerId: string;
  attempt: number;
}

/** The lease of a task returned by `claimDueTasks`. */
export function taskLease(task: Pick<ScheduledTaskRow, "id" | "attempts">, workerId: string) {
  return { id: task.id, workerId, attempt: task.attempts } satisfies TaskLease;
}

function holdsLease(lease: TaskLease): SQL | undefined {
  return and(
    eq(scheduledTasks.id, lease.id),
    eq(scheduledTasks.status, "running"),
    eq(scheduledTasks.lockedBy, lease.workerId),
    eq(scheduledTasks.attempts, lease.attempt),
  );
}

/**
 * Renews the lease of a running task to `leaseMs` from now. Returns the new `lockedUntil`, or null
 * when the run no longer holds the task (it was taken over or finished): stop the handler then.
 */
export async function extendLease(
  db: TaskExecutor,
  lease: TaskLease & { leaseMs: number; now?: Date },
): Promise<Date | null> {
  const [row] = await db
    .update(scheduledTasks)
    .set({ lockedUntil: plusMs(lease.now, lease.leaseMs) })
    .where(holdsLease(lease))
    .returning({ lockedUntil: scheduledTasks.lockedUntil });
  return row?.lockedUntil ?? null;
}

/**
 * How a run ended:
 * - `succeeded`: done.
 * - `pending`: failed, retry at `runAt` (the caller computes it with `taskRetryDelayMs`).
 * - `failed`: failed with an error a retry cannot fix.
 * - `dead`: failed and no attempt is left.
 */
export type TaskOutcome =
  | { status: "succeeded" }
  | { status: "pending"; runAt: Date; error: TaskError }
  | { status: "failed" | "dead"; error: TaskError };

/**
 * Records the outcome of a run and releases its lease. Returns the updated task, or null when the
 * run no longer held the task (another instance took it over), in which case nothing changed.
 * `lastError` keeps the latest failure, also after a later success.
 */
export async function completeTask(
  db: TaskExecutor,
  lease: TaskLease & { now?: Date },
  outcome: TaskOutcome,
): Promise<ScheduledTaskRow | null> {
  const finishedAt = outcome.status === "pending" ? null : at(lease.now);
  const [row] = await db
    .update(scheduledTasks)
    .set({
      status: outcome.status,
      lockedBy: null,
      lockedUntil: null,
      finishedAt,
      ...(outcome.status === "pending" ? { runAt: outcome.runAt } : {}),
      ...(outcome.status === "succeeded" ? {} : { lastError: outcome.error }),
    })
    .where(holdsLease(lease))
    .returning();
  return row ?? null;
}

/**
 * Puts a `failed` or `dead` task back to `pending` at `runAt` (default now) with its attempts reset,
 * for an admin's manual retry. Returns null when the task is missing or in another status. Fails
 * with a unique violation on `scheduled_tasks_dedupe_key_uq` when another pending or running task
 * holds its dedupe key.
 */
export async function retryTask(
  db: TaskExecutor,
  options: { id: string; runAt?: Date; now?: Date },
): Promise<ScheduledTaskRow | null> {
  const [row] = await db
    .update(scheduledTasks)
    .set({
      status: "pending",
      runAt: options.runAt ?? at(options.now),
      attempts: 0,
      lockedBy: null,
      lockedUntil: null,
      finishedAt: null,
    })
    .where(
      and(eq(scheduledTasks.id, options.id), inArray(scheduledTasks.status, ["failed", "dead"])),
    )
    .returning();
  return row ?? null;
}
