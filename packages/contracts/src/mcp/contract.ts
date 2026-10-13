import { z } from "zod";
import type { TokenScope } from "../enums";

/** Streamable HTTP endpoint of the MCP server, relative to the server URL. */
export const MCP_PATH = "/mcp";

/**
 * Whether a job token (`lc_job_…`, handed to a producer session for one job) may call a tool.
 * User MCP tokens are governed by `scope` alone.
 */
export const MCP_JOB_TOKEN_POLICIES = ["allow", "deny"] as const;
export const McpJobTokenPolicySchema = z.enum(MCP_JOB_TOKEN_POLICIES);
export type McpJobTokenPolicy = (typeof MCP_JOB_TOKEN_POLICIES)[number];

/**
 * How a tool call is tied to a project.
 *
 * - `input`: the input names one project, directly (`projectId`, `idOrSlug`) or through a record
 *   that belongs to one (`entryId`). The server resolves it and refuses a job token for any
 *   project other than its job's. When an optional `projectId` is left out, a job token is bound
 *   to its job's project.
 * - `none`: the input names no project. A job token only sees its job's project in the result.
 */
export const MCP_PROJECT_BINDINGS = ["input", "none"] as const;
export const McpProjectBindingSchema = z.enum(MCP_PROJECT_BINDINGS);
export type McpProjectBinding = (typeof MCP_PROJECT_BINDINGS)[number];

/**
 * Contract of one MCP tool: its name, the scope a token needs, whether job tokens may call it, how
 * it is tied to a project, and its input and output. The server returns each output as
 * `structuredContent` with a short text summary.
 */
export interface McpToolContract {
  readonly name: string;
  readonly scope: TokenScope;
  readonly jobTokens: McpJobTokenPolicy;
  readonly projectBinding: McpProjectBinding;
  readonly description: string;
  readonly input: z.ZodObject;
  readonly output: z.ZodObject;
}
