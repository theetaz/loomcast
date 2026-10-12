import { z } from "zod";
import { IdSchema, MAX_ASSISTANT_TEXT_LENGTH, MessageTextSchema } from "../common";
import { JOB_TYPES, type JobType } from "../enums";
import type { ConcurrencyClass } from "./concurrency";
import type { JobEventKind } from "./durable-events";

/** What happens when a running job's lease expires. */
export type LeaseExpiryPolicy = "requeue" | "fail";

export interface JobDefinition {
  /** Validated by the server before the job is inserted and by the agent before it runs. */
  readonly payload: z.ZodType;
  /** Validated by the server when the agent sends `job.complete`. */
  readonly result: z.ZodType;
  /** Durable event kinds the handler may emit. */
  readonly durableEventKinds: readonly JobEventKind[];
  /** The agent aborts the handler after this long. */
  readonly timeoutMs: number;
  readonly retry: {
    /** Total attempts, including the first. */
    readonly maxAttempts: number;
    /**
     * `requeue`: queue the job again while `attempt < maxAttempts` (idempotent jobs only).
     * `fail`: fail it with `{code: "interrupted", retryable: true}` and let the user retry.
     */
    readonly onLeaseExpiry: LeaseExpiryPolicy;
  };
  readonly concurrencyClass: ConcurrencyClass;
}

export const SystemPingPayloadSchema = z.object({});
export type SystemPingPayload = z.infer<typeof SystemPingPayloadSchema>;

export const SystemPingResultSchema = z.object({
  agentVersion: z.string().min(1).max(64),
  runtime: z.object({
    node: z.string().min(1).max(64),
    platform: z.string().min(1).max(64),
  }),
  producerAvailable: z.boolean(),
});
export type SystemPingResult = z.infer<typeof SystemPingResultSchema>;

/**
 * One chat turn. `producerSessionId` resumes the conversation's producer session; without it the
 * agent starts a new session.
 */
export const ProducerChatPayloadSchema = z.object({
  conversationId: IdSchema,
  projectId: IdSchema,
  messageId: IdSchema,
  text: MessageTextSchema,
  producerSessionId: z.string().min(1).max(200).optional(),
});
export type ProducerChatPayload = z.infer<typeof ProducerChatPayloadSchema>;

/** `sdkSessionId` is stored on the conversation and sent back as `producerSessionId` next turn. */
export const ProducerChatResultSchema = z.object({
  sdkSessionId: z.string().min(1).max(200),
  finalText: z.string().max(MAX_ASSISTANT_TEXT_LENGTH),
  numTurns: z.number().int().min(0),
  durationMs: z.number().min(0),
});
export type ProducerChatResult = z.infer<typeof ProducerChatResultSchema>;

/**
 * The job allow-list. The server and the studio agent both refuse job types and payloads that are
 * not described here. No job type carries a shell command.
 */
export const jobRegistry = {
  "system.ping": {
    payload: SystemPingPayloadSchema,
    result: SystemPingResultSchema,
    durableEventKinds: ["status", "log"],
    timeoutMs: 30_000,
    retry: { maxAttempts: 3, onLeaseExpiry: "requeue" },
    concurrencyClass: "producer",
  },
  "producer.chat": {
    payload: ProducerChatPayloadSchema,
    result: ProducerChatResultSchema,
    durableEventKinds: ["status", "session", "tool.activity", "assistant.message", "usage", "log"],
    timeoutMs: 30 * 60_000,
    retry: { maxAttempts: 1, onLeaseExpiry: "fail" },
    concurrencyClass: "producer",
  },
} as const satisfies { readonly [T in JobType]: JobDefinition };

export type JobRegistry = typeof jobRegistry;
export type JobPayload<T extends JobType> = z.output<JobRegistry[T]["payload"]>;
export type JobResult<T extends JobType> = z.output<JobRegistry[T]["result"]>;

/** The registry seen per job type, so generic lookups keep the payload and result types. */
const typedRegistry: {
  readonly [T in JobType]: {
    readonly payload: z.ZodType<JobPayload<T>>;
    readonly result: z.ZodType<JobResult<T>>;
  };
} = jobRegistry;

export function isJobType(value: string): value is JobType {
  return (JOB_TYPES as readonly string[]).includes(value);
}

export function getJobDefinition(type: JobType): JobDefinition {
  return jobRegistry[type];
}

/** Validates a payload against the registry schema of `type`. */
export function parseJobPayload<T extends JobType>(
  type: T,
  payload: unknown,
): z.ZodSafeParseResult<JobPayload<T>> {
  return typedRegistry[type].payload.safeParse(payload);
}

/** Validates a `job.complete` result against the registry schema of `type`. */
export function parseJobResult<T extends JobType>(
  type: T,
  result: unknown,
): z.ZodSafeParseResult<JobResult<T>> {
  return typedRegistry[type].result.safeParse(result);
}

/** Whether a handler of `type` may emit durable events of `kind`. */
export function allowsEventKind(type: JobType, kind: JobEventKind): boolean {
  return getJobDefinition(type).durableEventKinds.includes(kind);
}
