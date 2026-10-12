import { z } from "zod";

// Enumerations shared by the database, API, web app and studio agent. The value arrays are the
// single source of truth: `@loomcast/db` builds its pg enums from them. Only M1 values are listed;
// later milestones add values together with a migration.

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
