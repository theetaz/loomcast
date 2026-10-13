import { z } from "zod";

// Enumerations shared by the database, API, web app and studio agent. The value arrays are the
// single source of truth: `@loomcast/db` builds its pg enums from them. Values are added together
// with a migration and never removed or renamed in place.

export const USER_ROLES = ["owner", "admin"] as const;
export const UserRoleSchema = z.enum(USER_ROLES);
export type UserRole = (typeof USER_ROLES)[number];

/**
 * `mcp`: a user's MCP token. `device`: a studio agent's bridge token. `job`: a short-lived MCP
 * token minted for one job and handed to its producer session in `job.assign`.
 */
export const TOKEN_KINDS = ["mcp", "device", "job"] as const;
export const TokenKindSchema = z.enum(TOKEN_KINDS);
export type TokenKind = (typeof TOKEN_KINDS)[number];

export const TOKEN_SCOPES = ["mcp:read", "mcp:write", "mcp:admin", "bridge"] as const;
export const TokenScopeSchema = z.enum(TOKEN_SCOPES);
export type TokenScope = (typeof TOKEN_SCOPES)[number];

/** Scopes an MCP token may carry. `mcp:admin` is reserved for the owner. */
export const MCP_TOKEN_SCOPES = [
  "mcp:read",
  "mcp:write",
  "mcp:admin",
] as const satisfies readonly TokenScope[];
export const McpTokenScopeSchema = z.enum(MCP_TOKEN_SCOPES);
export type McpTokenScope = (typeof MCP_TOKEN_SCOPES)[number];

export const PROJECT_STATUSES = ["active", "archived"] as const;
export const ProjectStatusSchema = z.enum(PROJECT_STATUSES);
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

/**
 * Fixed allow-list of job types. A value is added only together with a migration and an entry in
 * the job registry (`jobRegistry`).
 */
export const JOB_TYPES = ["system.ping", "producer.chat", "kb.analyze_reference"] as const;
export const JobTypeSchema = z.enum(JOB_TYPES);
export type JobType = (typeof JOB_TYPES)[number];

export const JOB_STATUSES = [
  "queued",
  "dispatched",
  "running",
  "succeeded",
  "failed",
  "cancelled",
] as const;
export const JobStatusSchema = z.enum(JOB_STATUSES);
export type JobStatus = (typeof JOB_STATUSES)[number];

/** Job statuses after which a job never changes again. */
export const TERMINAL_JOB_STATUSES = [
  "succeeded",
  "failed",
  "cancelled",
] as const satisfies readonly JobStatus[];

export const MESSAGE_ROLES = ["user", "assistant", "system", "event"] as const;
export const MessageRoleSchema = z.enum(MESSAGE_ROLES);
export type MessageRole = (typeof MESSAGE_ROLES)[number];

export const ACTOR_KINDS = ["user", "device", "token", "system"] as const;
export const ActorKindSchema = z.enum(ACTOR_KINDS);
export type ActorKind = (typeof ACTOR_KINDS)[number];

/** Kinds of knowledge-base entries. `session_summary` entries are written only through MCP. */
export const KB_ENTRY_KINDS = [
  "brainstorm",
  "reference",
  "decision",
  "note",
  "session_summary",
] as const;
export const KbEntryKindSchema = z.enum(KB_ENTRY_KINDS);
export type KbEntryKind = (typeof KB_ENTRY_KINDS)[number];

/**
 * How a knowledge-base entry was written: in the web app, by an MCP client, by a producer session
 * running a job, or by the optional session-end hook.
 */
export const KB_CREATED_VIA = ["ui", "mcp", "producer", "hook"] as const;
export const KbCreatedViaSchema = z.enum(KB_CREATED_VIA);
export type KbCreatedVia = (typeof KB_CREATED_VIA)[number];

/** Platforms a reference link can point at. Anything unrecognised is `other`. */
export const REFERENCE_PLATFORMS = [
  "instagram",
  "tiktok",
  "youtube",
  "threads",
  "x",
  "facebook",
  "other",
] as const;
export const ReferencePlatformSchema = z.enum(REFERENCE_PLATFORMS);
export type ReferencePlatform = (typeof REFERENCE_PLATFORMS)[number];

/** Progress of a reference's `kb.analyze_reference` job, as stored on the reference. */
export const REFERENCE_ANALYSIS_STATUSES = ["none", "queued", "running", "done", "failed"] as const;
export const ReferenceAnalysisStatusSchema = z.enum(REFERENCE_ANALYSIS_STATUSES);
export type ReferenceAnalysisStatus = (typeof REFERENCE_ANALYSIS_STATUSES)[number];

/** What a one-time set-password link was issued for. */
export const PASSWORD_TOKEN_PURPOSES = ["invite", "reset"] as const;
export const PasswordTokenPurposeSchema = z.enum(PASSWORD_TOKEN_PURPOSES);
export type PasswordTokenPurpose = (typeof PASSWORD_TOKEN_PURPOSES)[number];

/**
 * States of a content item. The production stages run `idea` to `render`; `review` waits for a
 * user's decision; `approved`, `scheduled` and `published` follow; `archived` sits outside the flow
 * and can be restored to `idea`. `PIPELINE_TRANSITIONS` says who may move an item between them.
 */
export const PIPELINE_STATES = [
  "idea",
  "script",
  "storyboard",
  "voice",
  "render",
  "review",
  "approved",
  "scheduled",
  "published",
  "archived",
] as const;
export const PipelineStateSchema = z.enum(PIPELINE_STATES);
export type PipelineState = (typeof PIPELINE_STATES)[number];

/** The production stages, in order. Each one is reached by adding one artifact to a version. */
export const PRODUCTION_STATES = [
  "idea",
  "script",
  "storyboard",
  "voice",
  "render",
] as const satisfies readonly PipelineState[];
export const ProductionStateSchema = z.enum(PRODUCTION_STATES);
export type ProductionState = (typeof PRODUCTION_STATES)[number];

/**
 * Production work a user (or autopilot) can start on an item. Each of the first five runs one job;
 * `produce` runs the missing steps one after another, up to a target state.
 */
export const CONTENT_ACTIONS = [
  "write_script",
  "storyboard",
  "voice",
  "render",
  "revise",
  "produce",
] as const;
export const ContentActionSchema = z.enum(CONTENT_ACTIONS);
export type ContentAction = (typeof CONTENT_ACTIONS)[number];

/**
 * How a content version was written: in the web app, through an MCP tool, from a job result, or by
 * the server itself (for example the first, empty version of a new item).
 */
export const VERSION_CREATED_VIA = ["ui", "mcp", "job", "system"] as const;
export const VersionCreatedViaSchema = z.enum(VERSION_CREATED_VIA);
export type VersionCreatedVia = (typeof VERSION_CREATED_VIA)[number];

/**
 * How a content item was created: in the web app, by an MCP client with a user token, by a
 * producer session with a job token, or by the server (for example a scheduler).
 */
export const CONTENT_CREATED_VIA = ["ui", "mcp", "producer", "system"] as const;
export const ContentCreatedViaSchema = z.enum(CONTENT_CREATED_VIA);
export type ContentCreatedVia = (typeof CONTENT_CREATED_VIA)[number];

/** A series either feeds the calendar, is paused, or is archived. */
export const SERIES_STATUSES = ["active", "paused", "archived"] as const;
export const SeriesStatusSchema = z.enum(SERIES_STATUSES);
export type SeriesStatus = (typeof SERIES_STATUSES)[number];

/** Whether a series publishes approved items on its own or waits for each approval. */
export const PUBLISH_MODES = ["auto", "approval"] as const;
export const PublishModeSchema = z.enum(PUBLISH_MODES);
export type PublishMode = (typeof PUBLISH_MODES)[number];

/** What a stored file is for. `reference_media` is a reference video or audio the user uploaded. */
export const ASSET_KINDS = [
  "voice",
  "render",
  "poster",
  "frame",
  "reference_media",
  "other",
] as const;
export const AssetKindSchema = z.enum(ASSET_KINDS);
export type AssetKind = (typeof ASSET_KINDS)[number];

/** `pending` until the upload is finalized and its checksum verified; `failed` on a mismatch. */
export const ASSET_STATUSES = ["pending", "ready", "failed"] as const;
export const AssetStatusSchema = z.enum(ASSET_STATUSES);
export type AssetStatus = (typeof ASSET_STATUSES)[number];

export const REVIEW_DECISIONS = ["approve", "request_changes", "reject"] as const;
export const ReviewDecisionSchema = z.enum(REVIEW_DECISIONS);
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

/** A `skill` teaches one step; a `recipe` strings steps together for one kind of video. */
export const SKILL_KINDS = ["skill", "recipe"] as const;
export const SkillKindSchema = z.enum(SKILL_KINDS);
export type SkillKind = (typeof SKILL_KINDS)[number];
