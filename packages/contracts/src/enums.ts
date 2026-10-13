import { z } from "zod";

// Enumerations shared by the database, API, web app and studio agent. The value arrays are the
// single source of truth: `@loomcast/db` builds its pg enums from them. Values are added together
// with a migration and never removed or renamed in place.

export const USER_ROLES = ["owner", "admin"] as const;
export const UserRoleSchema = z.enum(USER_ROLES);
export type UserRole = (typeof USER_ROLES)[number];

export const TOKEN_KINDS = ["mcp", "device"] as const;
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
export const JOB_TYPES = ["system.ping", "producer.chat"] as const;
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
