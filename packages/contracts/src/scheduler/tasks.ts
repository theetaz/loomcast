import { z } from "zod";
import { IdSchema, TimestampSchema } from "../common";

// The scheduler runs server-side tasks at a set time: planning cadence slots, starting production
// ahead of a slot, publishing a post and polling the platform until it is live. Tasks are not jobs:
// they never reach the studio agent. `scheduledTaskRegistry` is their allow-list.

/**
 * Kinds of scheduled tasks. `scheduled_tasks.kind` is stored as text, so a new kind needs an entry
 * in `scheduledTaskRegistry` but no migration.
 */
export const SCHEDULED_TASK_KINDS = [
  "cadence.plan",
  "cadence.produce",
  "post.publish",
  "post.check_status",
  "assets.cleanup",
] as const;
export const ScheduledTaskKindSchema = z.enum(SCHEDULED_TASK_KINDS);
export type ScheduledTaskKind = (typeof SCHEDULED_TASK_KINDS)[number];

export interface ScheduledTaskDefinition {
  /** Validated when the task is enqueued and again before its handler runs. */
  readonly payload: z.ZodType;
  /** Total attempts, including the first. After the last failed attempt the task is `dead`. */
  readonly maxAttempts: number;
  /** Base of the retry backoff (`taskRetryDelayMs`). */
  readonly backoffBaseMs: number;
  /** How long a claim holds. The scheduler extends it every `leaseMs / 2` while the handler runs. */
  readonly leaseMs: number;
}

/** The longest retry delay, whatever the attempt. */
export const TASK_BACKOFF_MAX_MS = 60 * 60_000;

/** Retry delays vary by up to this share either way, so failed tasks do not retry in lockstep. */
export const TASK_BACKOFF_JITTER = 0.2;

/**
 * Plans cadence slots into items and planned posts over the planning horizon. Runs hourly for every
 * active series, or for one series right after its cadence or channels change.
 */
export const CadencePlanPayloadSchema = z.object({
  seriesId: IdSchema.optional(),
});
export type CadencePlanPayload = z.infer<typeof CadencePlanPayloadSchema>;

/** Starts production of a planned item, `leadTimeHours` before its slot. */
export const CadenceProducePayloadSchema = z.object({
  itemId: IdSchema,
});
export type CadenceProducePayload = z.infer<typeof CadenceProducePayloadSchema>;

/** Publishes one post at its time. */
export const PostPublishPayloadSchema = z.object({
  postId: IdSchema,
});
export type PostPublishPayload = z.infer<typeof PostPublishPayloadSchema>;

/**
 * Asks the platform whether a post it accepted has finished processing. `since` is when the
 * publish attempt started; polling gives up `POST_STATUS_TIMEOUT_MS` after it.
 */
export const PostCheckStatusPayloadSchema = z.object({
  postId: IdSchema,
  since: TimestampSchema,
});
export type PostCheckStatusPayload = z.infer<typeof PostCheckStatusPayloadSchema>;

/** Removes stale pending uploads and the objects of failed assets. */
export const AssetsCleanupPayloadSchema = z.object({});
export type AssetsCleanupPayload = z.infer<typeof AssetsCleanupPayloadSchema>;

/** First delay between status polls of a processing post. */
export const POST_STATUS_POLL_INITIAL_MS = 15_000;
/** Polls back off to at most this delay. */
export const POST_STATUS_POLL_MAX_MS = 60_000;
/** A post still processing this long after its publish attempt started has failed. */
export const POST_STATUS_TIMEOUT_MS = 20 * 60_000;

/** How often the recurring planning and cleanup tasks run. */
export const RECURRING_TASK_INTERVAL_MS = 60 * 60_000;

/** The allow-list of scheduled tasks, with the payload, retry policy and lease of each kind. */
export const scheduledTaskRegistry = {
  "cadence.plan": {
    payload: CadencePlanPayloadSchema,
    maxAttempts: 3,
    backoffBaseMs: 60_000,
    leaseMs: 5 * 60_000,
  },
  "cadence.produce": {
    payload: CadenceProducePayloadSchema,
    maxAttempts: 5,
    backoffBaseMs: 2 * 60_000,
    leaseMs: 2 * 60_000,
  },
  "post.publish": {
    payload: PostPublishPayloadSchema,
    maxAttempts: 5,
    backoffBaseMs: 60_000,
    leaseMs: 5 * 60_000,
  },
  "post.check_status": {
    payload: PostCheckStatusPayloadSchema,
    maxAttempts: 5,
    backoffBaseMs: POST_STATUS_POLL_INITIAL_MS,
    leaseMs: 60_000,
  },
  "assets.cleanup": {
    payload: AssetsCleanupPayloadSchema,
    maxAttempts: 3,
    backoffBaseMs: 5 * 60_000,
    leaseMs: 10 * 60_000,
  },
} as const satisfies Record<ScheduledTaskKind, ScheduledTaskDefinition>;

export type ScheduledTaskRegistry = typeof scheduledTaskRegistry;
export type ScheduledTaskPayload<K extends ScheduledTaskKind> = z.output<
  ScheduledTaskRegistry[K]["payload"]
>;

const typedTaskRegistry: {
  readonly [K in ScheduledTaskKind]: { readonly payload: z.ZodType<ScheduledTaskPayload<K>> };
} = scheduledTaskRegistry;

export function isScheduledTaskKind(value: string): value is ScheduledTaskKind {
  return (SCHEDULED_TASK_KINDS as readonly string[]).includes(value);
}

export function getScheduledTaskDefinition(kind: ScheduledTaskKind): ScheduledTaskDefinition {
  return scheduledTaskRegistry[kind];
}

/** Validates a payload against the registry schema of `kind`. */
export function parseScheduledTaskPayload<K extends ScheduledTaskKind>(
  kind: K,
  payload: unknown,
): z.ZodSafeParseResult<ScheduledTaskPayload<K>> {
  return typedTaskRegistry[kind].payload.safeParse(payload);
}

/**
 * The delay before retrying a task whose run number `attempt` (1 for the first run) just failed:
 * `min(backoffBaseMs · 2^(attempt − 1), 1 h)`, varied by ±20%. `random` returns a value in [0, 1);
 * pass a fixed one in tests.
 */
export function taskRetryDelayMs(
  backoffBaseMs: number,
  attempt: number,
  random: () => number = Math.random,
): number {
  const exponent = Math.max(0, Math.floor(attempt) - 1);
  const base = Math.min(backoffBaseMs * 2 ** Math.min(exponent, 30), TASK_BACKOFF_MAX_MS);
  const factor = 1 + TASK_BACKOFF_JITTER * (2 * random() - 1);
  return Math.round(base * factor);
}
