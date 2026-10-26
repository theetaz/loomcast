import {
  getJobDefinition,
  IdSchema,
  isJobType,
  type JobSummary,
  type JobType,
  type JsonObject,
  parseJobPayload,
} from "@loomcast/contracts";
import { type Database, type JobRow, jobs } from "@loomcast/db";
import { and, eq, sql } from "drizzle-orm";
import type { EventBus } from "../../lib/bus";
import { afterCommit, type Executor } from "../../lib/db";
import { validationFailed } from "../../lib/errors";
import { issueDetails } from "../../lib/http";

export const IDEMPOTENCY_KEY_MAX_LENGTH = 255;

export interface EnqueueInput {
  type: JobType;
  /** Validated against the registry schema of `type`; the parsed value is stored. */
  payload: unknown;
  workspaceId: string;
  conversationId?: string | null;
  /** Only this studio agent may run the job (conversation session affinity). */
  deviceAffinity?: string | null;
  /** Repeating a key for the same `createdBy` returns the first job instead of a new one. */
  idempotencyKey?: string | null;
  createdBy: string;
}

export interface EnqueueResult {
  job: JobRow;
  /** False when an earlier job with the same idempotency key was returned. */
  created: boolean;
}

export interface JobsService {
  /**
   * Validates the job against the registry and inserts it as `queued` on `tx`, or returns the
   * existing job when `idempotencyKey` was used before by the same user. A new job publishes
   * `job.enqueued` once `tx` commits (see `transaction` in `lib/db`).
   *
   * Throws an `HttpError` (400 `validation_failed`) for an unknown type or an invalid payload.
   */
  enqueue(tx: Executor, input: EnqueueInput): Promise<EnqueueResult>;
  /** A job by id, or null. */
  get(id: string, executor?: Executor): Promise<JobRow | null>;
}

export function toJobSummary(row: JobRow): JobSummary {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    workspaceId: row.workspaceId,
    conversationId: row.conversationId,
    claimedByDevice: row.claimedByDevice,
    attempt: row.attempt,
    maxAttempts: row.maxAttempts,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    dispatchedAt: row.dispatchedAt?.toISOString() ?? null,
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    cancelRequestedAt: row.cancelRequestedAt?.toISOString() ?? null,
  };
}

export function createJobsService(deps: { db: Database; bus: EventBus }): JobsService {
  const { db, bus } = deps;

  return {
    async enqueue(tx, input) {
      if (!isJobType(input.type)) {
        throw validationFailed([{ path: "type", message: "Unknown job type" }]);
      }
      const parsed = parseJobPayload(input.type, input.payload);
      if (!parsed.success) {
        throw validationFailed(
          issueDetails(parsed.error).map((issue) => ({
            ...issue,
            path: issue.path === "" ? "payload" : `payload.${issue.path}`,
          })),
          "The job payload is not valid.",
        );
      }
      const key = input.idempotencyKey ?? null;
      if (key !== null && (key.length === 0 || key.length > IDEMPOTENCY_KEY_MAX_LENGTH)) {
        throw validationFailed([
          {
            path: "idempotencyKey",
            message: `Must be 1 to ${IDEMPOTENCY_KEY_MAX_LENGTH} characters`,
          },
        ]);
      }

      const [inserted] = await tx
        .insert(jobs)
        .values({
          type: input.type,
          payload: parsed.data as JsonObject,
          workspaceId: input.workspaceId,
          conversationId: input.conversationId ?? null,
          deviceAffinity: input.deviceAffinity ?? null,
          idempotencyKey: key,
          maxAttempts: getJobDefinition(input.type).retry.maxAttempts,
          createdBy: input.createdBy,
        })
        .onConflictDoNothing({
          target: [jobs.createdBy, jobs.idempotencyKey],
          where: sql`${jobs.idempotencyKey} is not null`,
        })
        .returning();

      if (inserted !== undefined) {
        afterCommit(tx, () =>
          bus.publish({
            type: "job.enqueued",
            payload: {
              jobId: inserted.id,
              type: inserted.type,
              workspaceId: inserted.workspaceId,
              deviceAffinity: inserted.deviceAffinity,
            },
          }),
        );
        return { job: inserted, created: true };
      }

      // Only a matching idempotency key can conflict, so the earlier job exists and is visible.
      const [existing] = await tx
        .select()
        .from(jobs)
        .where(and(eq(jobs.createdBy, input.createdBy), eq(jobs.idempotencyKey, key ?? "")))
        .limit(1);
      if (existing === undefined) {
        throw new Error("idempotent job conflict without an existing job");
      }
      return { job: existing, created: false };
    },

    async get(id, executor = db) {
      if (!IdSchema.safeParse(id).success) {
        return null;
      }
      const [row] = await executor.select().from(jobs).where(eq(jobs.id, id)).limit(1);
      return row ?? null;
    },
  };
}
