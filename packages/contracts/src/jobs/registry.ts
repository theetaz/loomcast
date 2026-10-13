import { z } from "zod";
import { KB_LIKED_REASON_MAX_LENGTH, ReferenceUrlSchema, TranscriptSchema } from "../api/kb";
import { REVIEW_COMMENT_MAX_LENGTH } from "../api/reviews";
import { IdSchema, MAX_ASSISTANT_TEXT_LENGTH, MessageTextSchema } from "../common";
import { JOB_TYPES, type JobType, type McpTokenScope, ReferencePlatformSchema } from "../enums";
import { MAX_ANALYSIS_SUMMARY_LENGTH, ReferenceAnalysisSchema } from "../kb/analysis";
import {
  MAX_TIMELINE_MS,
  ScriptSchema,
  StoryboardSchema,
  VoiceAlignmentSchema,
} from "../pipeline/artifacts";
import {
  FormatRulesSchema,
  VOICE_SPEED_MAX,
  VOICE_SPEED_MIN,
  VoiceIdSchema,
} from "../pipeline/format-rules";
import { SkillNameSchema, SkillVersionNumberSchema } from "../pipeline/skills";
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
 * agent starts a new session. `contentItemId` is set in an item's own conversation.
 */
export const ProducerChatPayloadSchema = z.object({
  conversationId: IdSchema,
  projectId: IdSchema,
  messageId: IdSchema,
  text: MessageTextSchema,
  producerSessionId: z.string().min(1).max(200).optional(),
  contentItemId: IdSchema.optional(),
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
 * Analyses a saved reference from its transcript, or from media the user uploaded
 * (`mediaAssetId`, a `reference_media` asset), which the agent transcribes first. At least one of
 * them is required. The transcript is untrusted text supplied by the user; the reference URL is
 * never fetched. The server stores the result on the reference.
 */
export const KbAnalyzeReferencePayloadSchema = z
  .object({
    projectId: IdSchema,
    entryId: IdSchema,
    url: ReferenceUrlSchema,
    platform: ReferencePlatformSchema,
    transcript: TranscriptSchema.optional(),
    mediaAssetId: IdSchema.optional(),
    likedReason: z.string().max(KB_LIKED_REASON_MAX_LENGTH).optional(),
  })
  .refine((payload) => payload.transcript !== undefined || payload.mediaAssetId !== undefined, {
    message: "Provide a transcript or uploaded media",
    path: ["transcript"],
  });
export type KbAnalyzeReferencePayload = z.infer<typeof KbAnalyzeReferencePayloadSchema>;

/** `transcript` is returned when the agent transcribed uploaded media. */
export const KbAnalyzeReferenceResultSchema = z.object({
  analysis: ReferenceAnalysisSchema,
  /** A short markdown summary for the reference card. */
  summaryMd: z.string().trim().min(1).max(MAX_ANALYSIS_SUMMARY_LENGTH),
  transcript: TranscriptSchema.optional(),
});
export type KbAnalyzeReferenceResult = z.infer<typeof KbAnalyzeReferenceResultSchema>;

/**
 * The format a production job runs with: the format version (null for an item without a series)
 * and a snapshot of its rules, so a later format change never alters a running job.
 */
export const FormatSnapshotSchema = z.object({
  formatVersionId: IdSchema.nullable(),
  rules: FormatRulesSchema,
});
export type FormatSnapshot = z.infer<typeof FormatSnapshotSchema>;

/**
 * Every production job names its item and the version it starts from, and carries the format
 * snapshot. Artifacts are read through MCP (`content.get`), never sent in the payload.
 */
const ContentJobFields = {
  projectId: IdSchema,
  itemId: IdSchema,
  /** The item's current version when the job was queued; the result builds on it. */
  versionId: IdSchema,
  format: FormatSnapshotSchema,
};

const ProducerNotesSchema = z.string().trim().max(MAX_ANALYSIS_SUMMARY_LENGTH);

/** Writes a script for the item from its title, pitch and the format rules. */
export const ContentWriteScriptPayloadSchema = z.object(ContentJobFields);
export type ContentWriteScriptPayload = z.infer<typeof ContentWriteScriptPayloadSchema>;

export const ContentWriteScriptResultSchema = z.object({
  script: ScriptSchema,
  /** Anything the producer wants the user to know, shown on the version. */
  notes: ProducerNotesSchema.optional(),
});
export type ContentWriteScriptResult = z.infer<typeof ContentWriteScriptResultSchema>;

/** Sets the version's script to cards of the format's style. */
export const ContentStoryboardPayloadSchema = z.object(ContentJobFields);
export type ContentStoryboardPayload = z.infer<typeof ContentStoryboardPayloadSchema>;

export const ContentStoryboardResultSchema = z.object({
  storyboard: StoryboardSchema,
});
export type ContentStoryboardResult = z.infer<typeof ContentStoryboardResultSchema>;

/**
 * Revises the script or storyboard. `instructions` is the owner's request (a review comment, set
 * together with `reviewId`), which the producer may treat as trusted.
 */
export const ContentRevisePayloadSchema = z.object({
  ...ContentJobFields,
  reviewId: IdSchema.optional(),
  instructions: z.string().trim().min(1).max(REVIEW_COMMENT_MAX_LENGTH).optional(),
});
export type ContentRevisePayload = z.infer<typeof ContentRevisePayloadSchema>;

/** At least one of `script` and `storyboard`; `summary` says what changed. */
export const ContentReviseResultSchema = z
  .object({
    script: ScriptSchema.optional(),
    storyboard: StoryboardSchema.optional(),
    summary: z.string().trim().min(1).max(MAX_ANALYSIS_SUMMARY_LENGTH),
  })
  .refine((result) => result.script !== undefined || result.storyboard !== undefined, {
    message: "Return a revised script or storyboard",
  });
export type ContentReviseResult = z.infer<typeof ContentReviseResultSchema>;

/**
 * Synthesizes the version's script with the TTS provider. `voice` comes from the format rules;
 * the server refuses to queue the job without one.
 */
export const ContentVoicePayloadSchema = z.object({
  ...ContentJobFields,
  voice: z.object({
    voiceId: VoiceIdSchema,
    speed: z.number().min(VOICE_SPEED_MIN).max(VOICE_SPEED_MAX).optional(),
  }),
});
export type ContentVoicePayload = z.infer<typeof ContentVoicePayloadSchema>;

/** The uploaded and finalized voice take, its length and word timings. */
export const ContentVoiceResultSchema = z.object({
  voiceAssetId: IdSchema,
  durationMs: z.number().int().min(1).max(MAX_TIMELINE_MS),
  alignment: VoiceAlignmentSchema,
});
export type ContentVoiceResult = z.infer<typeof ContentVoiceResultSchema>;

/** Renders the version's storyboard over its voice take. */
export const ContentRenderPayloadSchema = z.object({
  ...ContentJobFields,
  voiceAssetId: IdSchema,
});
export type ContentRenderPayload = z.infer<typeof ContentRenderPayloadSchema>;

/** The uploaded and finalized render and poster, with the measured length and size. */
export const ContentRenderResultSchema = z.object({
  renderAssetId: IdSchema,
  posterAssetId: IdSchema,
  durationMs: z.number().int().min(1).max(MAX_TIMELINE_MS),
  width: z.number().int().min(1).max(16_384),
  height: z.number().int().min(1).max(16_384),
});
export type ContentRenderResult = z.infer<typeof ContentRenderResultSchema>;

export const SKILLS_SYNC_MAX = 500;

/** Pulls published skills into the agent's workspace: the named ones, or all of them. */
export const SkillsSyncPayloadSchema = z.object({
  names: z
    .array(SkillNameSchema)
    .min(1)
    .max(SKILLS_SYNC_MAX)
    .refine((names) => new Set(names).size === names.length, {
      message: "Names must not repeat",
    })
    .optional(),
});
export type SkillsSyncPayload = z.infer<typeof SkillsSyncPayloadSchema>;

export const SkillsSyncResultSchema = z.object({
  synced: z
    .array(z.object({ name: SkillNameSchema, version: SkillVersionNumberSchema }))
    .max(SKILLS_SYNC_MAX),
});
export type SkillsSyncResult = z.infer<typeof SkillsSyncResultSchema>;

const PRODUCER_STEP_EVENTS = ["status", "session", "tool.activity", "usage", "log"] as const;
const RENDER_STEP_EVENTS = ["status", "log"] as const;

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
  "content.write_script": {
    payload: ContentWriteScriptPayloadSchema,
    result: ContentWriteScriptResultSchema,
    durableEventKinds: PRODUCER_STEP_EVENTS,
    timeoutMs: 20 * 60_000,
    retry: { maxAttempts: 2, onLeaseExpiry: "requeue" },
    concurrencyClass: "producer",
    mcpAccess: "read_write",
  },
  "content.storyboard": {
    payload: ContentStoryboardPayloadSchema,
    result: ContentStoryboardResultSchema,
    durableEventKinds: PRODUCER_STEP_EVENTS,
    timeoutMs: 20 * 60_000,
    retry: { maxAttempts: 2, onLeaseExpiry: "requeue" },
    concurrencyClass: "producer",
    mcpAccess: "read_write",
  },
  "content.revise": {
    payload: ContentRevisePayloadSchema,
    result: ContentReviseResultSchema,
    durableEventKinds: PRODUCER_STEP_EVENTS,
    timeoutMs: 20 * 60_000,
    retry: { maxAttempts: 1, onLeaseExpiry: "fail" },
    concurrencyClass: "producer",
    mcpAccess: "read_write",
  },
  "content.voice": {
    payload: ContentVoicePayloadSchema,
    result: ContentVoiceResultSchema,
    durableEventKinds: RENDER_STEP_EVENTS,
    timeoutMs: 10 * 60_000,
    retry: { maxAttempts: 3, onLeaseExpiry: "requeue" },
    concurrencyClass: "render",
    mcpAccess: "read_write",
  },
  "content.render": {
    payload: ContentRenderPayloadSchema,
    result: ContentRenderResultSchema,
    durableEventKinds: RENDER_STEP_EVENTS,
    timeoutMs: 45 * 60_000,
    retry: { maxAttempts: 2, onLeaseExpiry: "requeue" },
    concurrencyClass: "render",
    mcpAccess: "read_write",
  },
  "skills.sync": {
    payload: SkillsSyncPayloadSchema,
    result: SkillsSyncResultSchema,
    durableEventKinds: RENDER_STEP_EVENTS,
    timeoutMs: 5 * 60_000,
    retry: { maxAttempts: 3, onLeaseExpiry: "requeue" },
    concurrencyClass: "render",
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
