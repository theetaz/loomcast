import { z } from "zod";
import { IdSchema, JsonObjectSchema, TimestampSchema } from "../common";
import { PlatformSchema, PublishingModeSchema } from "../enums";
import { PublishErrorSchema } from "../publishing/request";

/**
 * One try at publishing a post. `request` is what was (or, in dry-run, would have been) sent,
 * with credentials removed; `response` is the platform's answer.
 */
export const PublishAttemptSchema = z.object({
  id: IdSchema,
  postId: IdSchema,
  /** 1 for the first attempt. */
  attempt: z.number().int().min(1),
  /** The platform adapter that built the request. */
  adapter: PlatformSchema,
  dryRun: z.boolean(),
  request: JsonObjectSchema.nullable(),
  response: JsonObjectSchema.nullable(),
  error: PublishErrorSchema.nullable(),
  startedAt: TimestampSchema,
  finishedAt: TimestampSchema.nullable(),
});
export type PublishAttempt = z.infer<typeof PublishAttemptSchema>;

/**
 * The publisher's switches. `mode` is the server's `PUBLISHING_MODE`; `enabled` is false while
 * publishing is paused (due posts wait); `lastTickAt` is the scheduler's last run, null before the
 * first one.
 */
export const PublisherStatusSchema = z.object({
  mode: PublishingModeSchema,
  enabled: z.boolean(),
  lastTickAt: TimestampSchema.nullable(),
});
export type PublisherStatus = z.infer<typeof PublisherStatusSchema>;
