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
 * How a tool call is tied to a workspace.
 *
 * - `input`: the input names one workspace, directly (`workspaceId`, `idOrSlug`) or through a record
 *   that belongs to one (`entryId`). The server resolves it and refuses a job token for any
 *   workspace other than its job's. When an optional `workspaceId` is left out, a job token is bound
 *   to its job's workspace.
 * - `none`: the input names no workspace. A job token only sees its job's workspace in the result.
 */
export const MCP_WORKSPACE_BINDINGS = ["input", "none"] as const;
export const McpWorkspaceBindingSchema = z.enum(MCP_WORKSPACE_BINDINGS);
export type McpWorkspaceBinding = (typeof MCP_WORKSPACE_BINDINGS)[number];

/**
 * Contract of one MCP tool: its name, the scope a token needs, whether job tokens may call it, how
 * it is tied to a workspace, and its input and output. The server returns each output as
 * `structuredContent` with a short text summary.
 */
export interface McpToolContract {
  readonly name: string;
  readonly scope: TokenScope;
  readonly jobTokens: McpJobTokenPolicy;
  readonly workspaceBinding: McpWorkspaceBinding;
  readonly description: string;
  readonly input: z.ZodObject;
  readonly output: z.ZodObject;
}
