import { z } from "zod";
import { KB_LIKED_REASON_MAX_LENGTH, ReferenceUrlSchema, TranscriptSchema } from "../api/kb";
import { IdSchema, MAX_ASSISTANT_TEXT_LENGTH, MessageTextSchema } from "../common";
import { JOB_TYPES, type JobType, type McpTokenScope, ReferencePlatformSchema } from "../enums";
import { MAX_ANALYSIS_SUMMARY_LENGTH, ReferenceAnalysisSchema } from "../kb/analysis";
import type { ConcurrencyClass } from "./concurrency";
import type { JobEventKind } from "./durable-events";

/**
 * MCP access of a job's producer session. For `read` and `read_write` the server mints a job token
 * (`lc_job_…`) with the matching scopes, bound to the job's project, and sends it in `job.assign`
 * as `credentials.mcp`. For `none` no token is minted and `credentials` is left out.
 */
export const MCP_ACCESS_LEVELS = ["none", "read", "read_write"] as const;
export const McpAccessSchema = z.enum(MCP_ACCESS_LEVELS);
export type McpAccess = (typeof MCP_ACCESS_LEVELS)[number];

/** The scopes a job token carries for each access level. */
export const MCP_ACCESS_SCOPES = {
  none: [],
  read: ["mcp:read"],
  read_write: ["mcp:read", "mcp:write"],
} as const satisfies Record<McpAccess, readonly McpTokenScope[]>;

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
  /** Whether the job's producer session may call the MCP server, and with which scopes. */
  readonly mcpAccess: McpAccess;
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
 * Analyses a saved reference from its transcript. The transcript is untrusted text supplied by the
 * user; nothing is downloaded. The server stores the result on the reference.
 */
export const KbAnalyzeReferencePayloadSchema = z.object({
  projectId: IdSchema,
  entryId: IdSchema,
  url: ReferenceUrlSchema,
  platform: ReferencePlatformSchema,
  transcript: TranscriptSchema,
  likedReason: z.string().max(KB_LIKED_REASON_MAX_LENGTH).optional(),
});
export type KbAnalyzeReferencePayload = z.infer<typeof KbAnalyzeReferencePayloadSchema>;

export const KbAnalyzeReferenceResultSchema = z.object({
  analysis: ReferenceAnalysisSchema,
  /** A short markdown summary for the reference card. */
  summaryMd: z.string().trim().min(1).max(MAX_ANALYSIS_SUMMARY_LENGTH),
});
export type KbAnalyzeReferenceResult = z.infer<typeof KbAnalyzeReferenceResultSchema>;

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
    mcpAccess: "none",
  },
  "producer.chat": {
    payload: ProducerChatPayloadSchema,
    result: ProducerChatResultSchema,
    durableEventKinds: ["status", "session", "tool.activity", "assistant.message", "usage", "log"],
    timeoutMs: 30 * 60_000,
    retry: { maxAttempts: 1, onLeaseExpiry: "fail" },
    concurrencyClass: "producer",
    mcpAccess: "read_write",
  },
  "kb.analyze_reference": {
    payload: KbAnalyzeReferencePayloadSchema,
    result: KbAnalyzeReferenceResultSchema,
    durableEventKinds: ["status", "session", "tool.activity", "usage", "log"],
    timeoutMs: 15 * 60_000,
    retry: { maxAttempts: 2, onLeaseExpiry: "requeue" },
    concurrencyClass: "producer",
    mcpAccess: "read",
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
