import type { JsonObject, McpToolContract } from "@loomcast/contracts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";
import { audit } from "../../../lib/audit";
import type { Executor } from "../../../lib/db";
import { HttpError } from "../../../lib/errors";
import type { Logger } from "../../../lib/logger";
import { hasScopes } from "../../tokens/service";
import type { McpCaller } from "../caller";

/** Audit action written for every tool call, whatever its outcome. */
export const TOOL_CALL_AUDIT_ACTION = "mcp.tool.called";

/** Message of every unexpected failure. Details stay in the server log. */
const INTERNAL_MESSAGE = "Something went wrong on our side.";

/**
 * A failure a tool reports to the client. `code` follows the REST `ApiError` codes (`forbidden`,
 * `not_found`, `conflict`, …), so clients see the same vocabulary on both surfaces.
 */
export class McpToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "McpToolError";
  }
}

export type ToolInput<C extends McpToolContract> = z.output<C["input"]>;
/** What a handler returns: anything the output schema accepts. Extra keys are stripped. */
export type ToolResult<C extends McpToolContract> = z.input<C["output"]>;
export type ToolOutput<C extends McpToolContract> = z.output<C["output"]>;

/** What `resolveWorkspace` gets: the caller, before any check that depends on the workspace. */
export interface ResolveContext {
  caller: McpCaller;
}

/** What a handler gets besides its input. */
export interface ToolContext {
  caller: McpCaller;
  /**
   * For `workspaceBinding: "input"` tools: the workspace the call is about. That is the workspace the
   * input names, or the caller's bound workspace when the input names none. Null when the input
   * names a workspace that does not exist (and the caller is not bound), and for `none` tools.
   */
  workspaceId: string | null;
  logger: Logger;
}

interface ToolImplementationBase<C extends McpToolContract> {
  /** Runs the tool. Throw `McpToolError` or an `HttpError` to report a failure. */
  handler(input: ToolInput<C>, ctx: ToolContext): Promise<ToolResult<C>>;
  /** One short line for clients that only show text. Name the ids a follow-up call needs. */
  summary(output: ToolOutput<C>): string;
  /**
   * Fields added to the audit row of a successful call, such as the records it changed, so the
   * row ties the token to them.
   */
  auditData?(output: ToolOutput<C>): JsonObject;
}

/**
 * `input` tools must say which workspace their input names, so the registry can hold a bound
 * caller (a job token) to its workspace before the handler runs:
 *
 * - a workspace id: the input names that workspace (resolve slugs and child records to it);
 * - null: the input names a workspace that does not exist;
 * - undefined: the input names no workspace (an optional `workspaceId` left out).
 */
export type ToolImplementation<C extends McpToolContract> = ToolImplementationBase<C> &
  (C["workspaceBinding"] extends "input"
    ? {
        resolveWorkspace(
          input: ToolInput<C>,
          ctx: ResolveContext,
        ): Promise<string | null | undefined>;
      }
    : { resolveWorkspace?: undefined });

/** Per request: who calls and where audit rows go. */
export interface ToolCallContext {
  caller: McpCaller;
  logger: Logger;
  /** Where the audit row of each call is written. */
  db: Executor;
}

/** A tool ready to register on an `McpServer`. */
export interface ToolDefinition {
  readonly contract: McpToolContract;
  /**
   * Runs one call: checks the scope, the job-token policy and the workspace binding, runs the
   * handler, validates the output and writes the audit row. `input` must already satisfy
   * `contract.input`: the SDK validates arguments against it before the callback runs.
   * Never throws; failures come back as `isError` results without stack traces.
   */
  run(input: unknown, ctx: ToolCallContext): Promise<CallToolResult>;
}

/**
 * Binds a contract from `@loomcast/contracts` (name, scope, job-token policy, workspace binding,
 * input and output schemas) to its implementation. Adding a tool is a matter of calling this in a
 * file under `tools/` and listing the result in `tools/index.ts`.
 */
export function defineTool<const C extends McpToolContract>(
  contract: C,
  implementation: ToolImplementation<C>,
): ToolDefinition {
  return {
    contract,
    async run(rawInput, ctx) {
      const { caller, logger } = ctx;
      const log = logger.child({ tool: contract.name });
      const input = rawInput as ToolInput<C>;
      const started = performance.now();
      let workspaceId: string | null = null;
      let result: CallToolResult;
      let outcome: "ok" | "denied" | "error";
      let code: string | undefined;
      let extra: JsonObject | undefined;

      try {
        authorize(contract, caller);
        workspaceId = await bindWorkspace(contract, implementation, input, caller);
        const raw = await implementation.handler(input, { caller, workspaceId, logger: log });
        const output = contract.output.parse(raw) as ToolOutput<C>;
        extra = implementation.auditData?.(output);
        result = {
          content: [{ type: "text", text: implementation.summary(output) }],
          structuredContent: output as Record<string, unknown>,
        };
        outcome = "ok";
      } catch (error) {
        const failure = toFailure(error);
        if (failure.code === "internal") {
          log.error({ err: error }, "mcp tool failed");
        }
        result = { content: [{ type: "text", text: failure.text }], isError: true };
        outcome = failure.code === "forbidden" ? "denied" : "error";
        code = failure.code;
      }

      const durationMs = Math.round(performance.now() - started);
      log.info({ outcome, code, durationMs, tokenId: caller.token.id }, "mcp tool call");
      await writeAudit(ctx, contract.name, { outcome, code, workspaceId, extra }).catch(
        (error: unknown) => {
          log.error({ err: error }, "mcp tool call audit failed");
        },
      );
      return result;
    },
  };
}

/** The token's scope, and for job tokens the contract's job-token policy. */
function authorize(contract: McpToolContract, caller: McpCaller): void {
  if (!hasScopes(caller.token, [contract.scope])) {
    throw new McpToolError(
      "forbidden",
      `This tool needs the ${contract.scope} scope, which the token does not have.`,
    );
  }
  if (caller.token.kind === "job" && contract.jobTokens !== "allow") {
    throw new McpToolError("forbidden", "Job tokens cannot call this tool.");
  }
}

/**
 * The workspace an `input` tool works on. A bound caller may only name its own workspace, and leaving
 * the workspace out binds the call to it.
 */
async function bindWorkspace<C extends McpToolContract>(
  contract: C,
  implementation: ToolImplementation<C>,
  input: ToolInput<C>,
  caller: McpCaller,
): Promise<string | null> {
  if (contract.workspaceBinding !== "input" || implementation.resolveWorkspace === undefined) {
    return null;
  }
  const named = await implementation.resolveWorkspace(input, { caller });
  if (caller.boundWorkspaceId === null) {
    return named ?? null;
  }
  if (named === undefined) {
    return caller.boundWorkspaceId;
  }
  if (named !== caller.boundWorkspaceId) {
    throw new McpToolError("forbidden", "This token can only be used with its own workspace.");
  }
  return named;
}

interface Failure {
  code: string;
  text: string;
}

/** A client-safe description of a failure: a code and a message, never a stack trace. */
function toFailure(error: unknown): Failure {
  if (error instanceof McpToolError) {
    return { code: error.code, text: `${error.code}: ${error.message}` };
  }
  if (error instanceof HttpError && error.status < 500) {
    return { code: error.code, text: `${error.code}: ${error.message}${fieldIssues(error)}` };
  }
  return { code: "internal", text: `internal: ${INTERNAL_MESSAGE}` };
}

/** The `{path, message}` issues of a validation failure, so the client can fix its arguments. */
function fieldIssues(error: HttpError): string {
  if (error.code !== "validation_failed" || !Array.isArray(error.details)) {
    return "";
  }
  const issues = error.details
    .filter(
      (issue): issue is { path: string; message: string } =>
        typeof issue === "object" &&
        issue !== null &&
        typeof issue.path === "string" &&
        typeof issue.message === "string",
    )
    .map((issue) => `${issue.path}: ${issue.message}`);
  return issues.length === 0 ? "" : ` (${issues.join("; ")})`;
}

async function writeAudit(
  ctx: ToolCallContext,
  tool: string,
  fields: {
    outcome: string;
    code: string | undefined;
    workspaceId: string | null;
    extra: JsonObject | undefined;
  },
): Promise<void> {
  const data: JsonObject = { ...fields.extra, outcome: fields.outcome };
  if (fields.code !== undefined) {
    data.code = fields.code;
  }
  if (fields.workspaceId !== null) {
    data.workspaceId = fields.workspaceId;
  }
  if (ctx.caller.jobId !== null) {
    data.jobId = ctx.caller.jobId;
  }
  await audit(ctx.db, {
    actorKind: "token",
    actorId: ctx.caller.token.id,
    action: TOOL_CALL_AUDIT_ACTION,
    targetType: "mcp_tool",
    targetId: tool,
    data,
    ip: ctx.caller.ip,
  });
}

/**
 * Serves `tool` under an older name too, so clients built before a rename keep working. The alias
 * shares the tool's schemas, policy and handler; only its name and description differ.
 */
export function legacyAlias(tool: ToolDefinition, name: string): ToolDefinition {
  return {
    contract: {
      ...tool.contract,
      name,
      description: `Deprecated: use ${tool.contract.name}. ${tool.contract.description}`,
    },
    run: (input, ctx) => tool.run(input, ctx),
  };
}

/**
 * Registers `tools` on a per-request server. The contract's schemas become the advertised input
 * and output schemas; read-only tools are marked as such.
 */
export function registerTools(
  server: McpServer,
  tools: readonly ToolDefinition[],
  ctx: ToolCallContext,
): void {
  for (const tool of tools) {
    const { contract } = tool;
    server.registerTool(
      contract.name,
      {
        description: contract.description,
        inputSchema: contract.input,
        outputSchema: contract.output,
        annotations: { readOnlyHint: contract.scope === "mcp:read" },
      },
      (input) => tool.run(input, ctx),
    );
  }
}
