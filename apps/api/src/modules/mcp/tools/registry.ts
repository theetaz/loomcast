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

/** What `resolveProject` gets: the caller, before any check that depends on the project. */
export interface ResolveContext {
  caller: McpCaller;
}

/** What a handler gets besides its input. */
export interface ToolContext {
  caller: McpCaller;
  /**
   * For `projectBinding: "input"` tools: the project the call is about. That is the project the
   * input names, or the caller's bound project when the input names none. Null when the input
   * names a project that does not exist (and the caller is not bound), and for `none` tools.
   */
  projectId: string | null;
  logger: Logger;
}

interface ToolImplementationBase<C extends McpToolContract> {
  /** Runs the tool. Throw `McpToolError` or an `HttpError` to report a failure. */
  handler(input: ToolInput<C>, ctx: ToolContext): Promise<ToolResult<C>>;
  /** One short line for clients that only show text. Name the ids a follow-up call needs. */
  summary(output: ToolOutput<C>): string;
}

/**
 * `input` tools must say which project their input names, so the registry can hold a bound
 * caller (a job token) to its project before the handler runs:
 *
 * - a project id: the input names that project (resolve slugs and child records to it);
 * - null: the input names a project that does not exist;
 * - undefined: the input names no project (an optional `projectId` left out).
 */
export type ToolImplementation<C extends McpToolContract> = ToolImplementationBase<C> &
  (C["projectBinding"] extends "input"
    ? {
        resolveProject(
          input: ToolInput<C>,
          ctx: ResolveContext,
        ): Promise<string | null | undefined>;
      }
    : { resolveProject?: undefined });

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
   * Runs one call: checks the scope, the job-token policy and the project binding, runs the
   * handler, validates the output and writes the audit row. `input` must already satisfy
   * `contract.input`: the SDK validates arguments against it before the callback runs.
   * Never throws; failures come back as `isError` results without stack traces.
   */
  run(input: unknown, ctx: ToolCallContext): Promise<CallToolResult>;
}

/**
 * Binds a contract from `@loomcast/contracts` (name, scope, job-token policy, project binding,
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
      let projectId: string | null = null;
      let result: CallToolResult;
      let outcome: "ok" | "denied" | "error";
      let code: string | undefined;

      try {
        authorize(contract, caller);
        projectId = await bindProject(contract, implementation, input, caller);
        const raw = await implementation.handler(input, { caller, projectId, logger: log });
        const output = contract.output.parse(raw) as ToolOutput<C>;
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
      await writeAudit(ctx, contract.name, { outcome, code, projectId }).catch((error: unknown) => {
        log.error({ err: error }, "mcp tool call audit failed");
      });
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
 * The project an `input` tool works on. A bound caller may only name its own project, and leaving
 * the project out binds the call to it.
 */
async function bindProject<C extends McpToolContract>(
  contract: C,
  implementation: ToolImplementation<C>,
  input: ToolInput<C>,
  caller: McpCaller,
): Promise<string | null> {
  if (contract.projectBinding !== "input" || implementation.resolveProject === undefined) {
    return null;
  }
  const named = await implementation.resolveProject(input, { caller });
  if (caller.boundProjectId === null) {
    return named ?? null;
  }
  if (named === undefined) {
    return caller.boundProjectId;
  }
  if (named !== caller.boundProjectId) {
    throw new McpToolError("forbidden", "This token can only be used with its own project.");
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
  fields: { outcome: string; code: string | undefined; projectId: string | null },
): Promise<void> {
  const data: JsonObject = { outcome: fields.outcome };
  if (fields.code !== undefined) {
    data.code = fields.code;
  }
  if (fields.projectId !== null) {
    data.projectId = fields.projectId;
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
