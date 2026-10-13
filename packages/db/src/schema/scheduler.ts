import type { JsonObject, TaskError } from "@loomcast/contracts";
import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { createdAt, timestamptz, uuidPrimaryKey } from "./columns";
import { taskStatus } from "./enums";

/** Longest task kind the database accepts. Kinds come from `SCHEDULED_TASK_KINDS`. */
export const SCHEDULED_TASK_KIND_DB_MAX_LENGTH = 100;

/**
 * Server-side work that runs at a set time: cadence planning, production ahead of a slot,
 * publishing and status polling. Tasks never reach the studio agent. `kind` is text, so a new kind
 * needs an entry in `scheduledTaskRegistry` but no migration; validate `kind` and `payload` against
 * the registry before running a task.
 *
 * Use the helpers in `src/queries/scheduler.ts` rather than writing the lifecycle by hand:
 * `enqueueTask` inserts (or reschedules a duplicate), `claimDueTasks` takes due tasks under a lease
 * with `FOR UPDATE SKIP LOCKED`, `extendLease` renews it and `completeTask` records the outcome.
 *
 * - `attempts` counts the runs started; a claim adds one, so `(id, attempts)` names one run.
 * - A `running` task carries its lease (`lockedBy`, `lockedUntil`). A lease that runs out is taken
 *   over by the next claim, or dead-lettered when no attempt is left.
 * - `dedupeKey` is unique among `pending` and `running` tasks only, so a key can be used again
 *   once its task has finished. An `ON CONFLICT` target must repeat the predicate.
 *
 * The index predicates use enum literals because an index predicate must be immutable and an
 * enum-to-text cast is not; that is safe because `task_status` is created, not extended, by the
 * same migration. The checks compare as text.
 */
export const scheduledTasks = pgTable(
  "scheduled_tasks",
  {
    id: uuidPrimaryKey(),
    kind: text("kind").notNull(),
    runAt: timestamptz("run_at").notNull().defaultNow(),
    /** Ids and options only, never secrets. */
    payload: jsonb("payload").$type<JsonObject>().notNull().default({}),
    status: taskStatus("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(1),
    lockedUntil: timestamptz("locked_until"),
    /** The scheduler instance that holds the lease. Unique per process. */
    lockedBy: text("locked_by"),
    lastError: jsonb("last_error").$type<TaskError>(),
    dedupeKey: text("dedupe_key"),
    createdAt: createdAt(),
    finishedAt: timestamptz("finished_at"),
  },
  (t) => [
    uniqueIndex("scheduled_tasks_dedupe_key_uq")
      .on(t.dedupeKey)
      .where(sql`${t.status} in ('pending', 'running')`),
    index("scheduled_tasks_pending_run_at_idx").on(t.runAt).where(sql`${t.status} = 'pending'`),
    index("scheduled_tasks_running_locked_until_idx")
      .on(t.lockedUntil)
      .where(sql`${t.status} = 'running'`),
    index("scheduled_tasks_status_run_at_idx").on(t.status, t.runAt.desc()),
    check(
      "scheduled_tasks_kind_ck",
      sql`char_length(${t.kind}) between 1 and ${sql.raw(String(SCHEDULED_TASK_KIND_DB_MAX_LENGTH))}`,
    ),
    check("scheduled_tasks_attempts_ck", sql`${t.attempts} >= 0`),
    check("scheduled_tasks_max_attempts_ck", sql`${t.maxAttempts} >= 1`),
    check(
      "scheduled_tasks_lease_ck",
      sql`${t.status}::text <> 'running' or (${t.lockedBy} is not null and ${t.lockedUntil} is not null)`,
    ),
  ],
);

export type ScheduledTaskRow = typeof scheduledTasks.$inferSelect;
export type NewScheduledTaskRow = typeof scheduledTasks.$inferInsert;
