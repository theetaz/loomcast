import type { JobError, JobEventKind, JsonObject } from "@loomcast/contracts";
import { sql } from "drizzle-orm";
import {
  bigserial,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, timestamptz, uuidPrimaryKey } from "./columns";
import { conversations } from "./conversations";
import { devices } from "./devices";
import { jobStatus, jobType } from "./enums";
import { projects } from "./projects";
import { users } from "./users";

/**
 * Work for a studio agent. `type` and `payload` are validated against the job registry before
 * insert. The dispatcher claims queued jobs with `FOR UPDATE SKIP LOCKED`, which the partial index
 * on queued jobs keeps cheap.
 */
export const jobs = pgTable(
  "jobs",
  {
    id: uuidPrimaryKey(),
    type: jobType("type").notNull(),
    status: jobStatus("status").notNull().default("queued"),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id),
    conversationId: uuid("conversation_id").references(() => conversations.id),
    deviceAffinity: uuid("device_affinity").references(() => devices.id, { onDelete: "set null" }),
    claimedByDevice: uuid("claimed_by_device").references(() => devices.id, {
      onDelete: "set null",
    }),
    payload: jsonb("payload").$type<JsonObject>().notNull(),
    result: jsonb("result").$type<JsonObject>(),
    error: jsonb("error").$type<JobError>(),
    idempotencyKey: text("idempotency_key"),
    attempt: integer("attempt").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(1),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    dispatchedAt: timestamptz("dispatched_at"),
    startedAt: timestamptz("started_at"),
    finishedAt: timestamptz("finished_at"),
    leaseExpiresAt: timestamptz("lease_expires_at"),
    cancelRequestedAt: timestamptz("cancel_requested_at"),
  },
  (t) => [
    uniqueIndex("jobs_created_by_idempotency_key_uq")
      .on(t.createdBy, t.idempotencyKey)
      .where(sql`${t.idempotencyKey} is not null`),
    index("jobs_queued_created_at_idx").on(t.createdAt).where(sql`${t.status} = 'queued'`),
    index("jobs_conversation_id_idx").on(t.conversationId),
    check("jobs_attempt_ck", sql`${t.attempt} >= 0`),
    check("jobs_max_attempts_ck", sql`${t.maxAttempts} >= 1`),
  ],
);

/**
 * Durable job events in the order the studio agent sent them. Replays after a reconnect are
 * de-duplicated with `ON CONFLICT (job_id, seq) DO NOTHING`.
 */
export const jobEvents = pgTable(
  "job_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    kind: text("kind").$type<JobEventKind>().notNull(),
    data: jsonb("data").$type<JsonObject>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("job_events_job_id_seq_uq").on(t.jobId, t.seq),
    check("job_events_seq_ck", sql`${t.seq} >= 1`),
  ],
);

export type JobRow = typeof jobs.$inferSelect;
export type NewJobRow = typeof jobs.$inferInsert;
export type JobEventRow = typeof jobEvents.$inferSelect;
export type NewJobEventRow = typeof jobEvents.$inferInsert;
