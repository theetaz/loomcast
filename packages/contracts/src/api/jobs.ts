import { z } from "zod";
import { IdSchema, TimestampSchema } from "../common";
import { JobStatusSchema, JobTypeSchema } from "../enums";

/** Error codes with a defined meaning. `JobError.code` stays an open string. */
export const JOB_ERROR_CODES = [
  /** The lease expired while the job was running, for example after a long disconnect. */
  "interrupted",
  /** The job was cancelled on request. */
  "cancelled",
  /** The job ran longer than its registry timeout. */
  "timeout",
  /** The payload did not match the registry schema. */
  "invalid_payload",
  /** The result did not match the registry schema. */
  "invalid_result",
  /** The studio agent has no handler for the job type. */
  "unsupported_job_type",
  /** The producer runtime on the workstation is not logged in. */
  "producer_not_authenticated",
  /** Any other failure inside the handler. */
  "internal",
] as const;
export type JobErrorCode = (typeof JOB_ERROR_CODES)[number];

/** Stored in `jobs.error` and sent in `job.fail`. */
export const JobErrorSchema = z.object({
  code: z.string().min(1).max(64),
  message: z.string().max(2_000),
  retryable: z.boolean(),
});
export type JobError = z.infer<typeof JobErrorSchema>;

/** A job as the web app sees it. Payload and result are left out. */
export const JobSummarySchema = z.object({
  id: IdSchema,
  type: JobTypeSchema,
  status: JobStatusSchema,
  workspaceId: IdSchema,
  conversationId: IdSchema.nullable(),
  claimedByDevice: IdSchema.nullable(),
  attempt: z.number().int().min(0),
  maxAttempts: z.number().int().min(1),
  error: JobErrorSchema.nullable(),
  createdAt: TimestampSchema,
  dispatchedAt: TimestampSchema.nullable(),
  startedAt: TimestampSchema.nullable(),
  finishedAt: TimestampSchema.nullable(),
  cancelRequestedAt: TimestampSchema.nullable(),
});
export type JobSummary = z.infer<typeof JobSummarySchema>;
