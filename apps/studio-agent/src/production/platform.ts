import {
  type AssetGetUrlInput,
  type AssetGetUrlOutput,
  AssetGetUrlOutputSchema,
  type ContentFinalizeAssetInput,
  type ContentFinalizeAssetOutput,
  ContentFinalizeAssetOutputSchema,
  type ContentGetInput,
  type ContentGetOutput,
  ContentGetOutputSchema,
  type ContentUploadAssetInput,
  type ContentUploadAssetOutput,
  ContentUploadAssetOutputSchema,
  type SkillPullInput,
  type SkillPullOutput,
  SkillPullOutputSchema,
} from "@loomcast/contracts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";
import { AGENT_VERSION } from "../agent-info";
import type { McpCredentials } from "../handlers";

/**
 * What production jobs read from and write to the platform. Every call goes through the
 * platform's MCP server with the job token, so a job reaches only its own workspace, and every
 * answer is checked against the contracts before it is used.
 */
export interface PlatformClient {
  getContent(input: ContentGetInput): Promise<ContentGetOutput>;
  uploadAsset(input: ContentUploadAssetInput): Promise<ContentUploadAssetOutput>;
  finalizeAsset(input: ContentFinalizeAssetInput): Promise<ContentFinalizeAssetOutput>;
  getAssetUrl(input: AssetGetUrlInput): Promise<AssetGetUrlOutput>;
  pullSkills(input: SkillPullInput): Promise<SkillPullOutput>;
  close(): Promise<void>;
}

/** Opens a platform client for one job. */
export type PlatformConnector = (
  credentials: McpCredentials,
  signal: AbortSignal,
) => Promise<PlatformClient>;

/**
 * A failed platform call. `code` is the server's error code (`not_found`, `conflict`,
 * `upload_missing`, …) when the tool reported one, `transport` when the server could not be
 * reached and `invalid_response` when its answer did not match the contract.
 */
export class PlatformError extends Error {
  override readonly name = "PlatformError";
  readonly code: string;
  readonly tool: string;

  constructor(tool: string, code: string, message: string) {
    super(message);
    this.code = code;
    this.tool = tool;
  }

  /** Whether trying the job again may help. */
  get retryable(): boolean {
    return this.code === "transport" || this.code === "rate_limited" || this.code === "internal";
  }
}

/** How long one tool call may take before it fails. */
export const PLATFORM_CALL_TIMEOUT_MS = 60_000;

/** The tool result shape the client reads. */
interface ToolResult {
  readonly isError?: boolean;
  readonly structuredContent?: unknown;
  readonly content?: unknown;
}

/** Calls one MCP tool and returns its raw result. */
export type ToolCaller = (
  name: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<ToolResult>;

/**
 * A platform client on top of an MCP tool caller. Successful results carry `structuredContent`;
 * failures carry `isError` and one text block, `"<code>: <message>"`.
 */
export function createPlatformClient(
  call: ToolCaller,
  signal: AbortSignal,
  close: () => Promise<void> = async () => {},
): PlatformClient {
  const invoke = async <S extends z.ZodType>(
    tool: string,
    args: object,
    schema: S,
  ): Promise<z.output<S>> => {
    let result: ToolResult;
    try {
      result = await call(tool, args as Record<string, unknown>, signal);
    } catch (error) {
      if (signal.aborted) {
        throw signal.reason;
      }
      // Timeouts and closed connections are transport failures; anything else the server refused.
      if (
        error instanceof McpError &&
        error.code !== ErrorCode.RequestTimeout &&
        error.code !== ErrorCode.ConnectionClosed
      ) {
        throw new PlatformError(tool, "protocol_error", `${tool} was refused: ${errorText(error)}`);
      }
      throw new PlatformError(
        tool,
        "transport",
        `The platform could not be reached for ${tool}: ${errorText(error)}`,
      );
    }
    if (result.isError === true) {
      const text = firstText(result.content);
      const match = /^([a-z][a-z0-9_]{1,63}):\s*([\s\S]*)$/.exec(text);
      throw new PlatformError(
        tool,
        match?.[1] ?? "tool_failed",
        truncate(`${tool} failed: ${match?.[2] ?? text}`, 1_000),
      );
    }
    const parsed = schema.safeParse(result.structuredContent);
    if (!parsed.success) {
      throw new PlatformError(
        tool,
        "invalid_response",
        `${tool} returned an answer that does not match its contract`,
      );
    }
    return parsed.data;
  };
  return {
    getContent: (input) => invoke("content.get", input, ContentGetOutputSchema),
    uploadAsset: (input) => invoke("content.upload_asset", input, ContentUploadAssetOutputSchema),
    finalizeAsset: (input) =>
      invoke("content.finalize_asset", input, ContentFinalizeAssetOutputSchema),
    getAssetUrl: (input) => invoke("asset.get_url", input, AssetGetUrlOutputSchema),
    pullSkills: (input) => invoke("skill.pull", input, SkillPullOutputSchema),
    close,
  };
}

/** Builds the transport of one job; tests pass an in-memory transport. */
export type TransportFactory = (credentials: McpCredentials) => Transport;

/**
 * Streamable HTTP to the platform's `/mcp` endpoint, with the job token as a bearer token. The
 * token is set on this job's requests only and never logged.
 */
export function httpTransport(credentials: McpCredentials): Transport {
  return new StreamableHTTPClientTransport(credentials.url, {
    requestInit: { headers: { Authorization: `Bearer ${credentials.token}` } },
  });
}

/** Connects an MCP client for one job and wraps it as a platform client. */
export function mcpPlatformConnector(
  transport: TransportFactory = httpTransport,
): PlatformConnector {
  return async (credentials, signal) => {
    const client = new Client({ name: "loomcast-studio-agent", version: AGENT_VERSION });
    try {
      await client.connect(transport(credentials), { signal, timeout: PLATFORM_CALL_TIMEOUT_MS });
    } catch (error) {
      await client.close().catch(() => {});
      if (signal.aborted) {
        throw signal.reason;
      }
      throw new PlatformError(
        "initialize",
        "transport",
        `The platform's MCP server could not be reached: ${errorText(error)}`,
      );
    }
    return createPlatformClient(
      async (name, args, callSignal) =>
        (await client.callTool({ name, arguments: args }, undefined, {
          signal: callSignal,
          timeout: PLATFORM_CALL_TIMEOUT_MS,
        })) as ToolResult,
      signal,
      () => client.close(),
    );
  };
}

function firstText(content: unknown): string {
  if (Array.isArray(content)) {
    for (const block of content) {
      if (
        typeof block === "object" &&
        block !== null &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string"
      ) {
        return (block as { text: string }).text;
      }
    }
  }
  return "The tool failed without a message";
}

function errorText(error: unknown): string {
  return truncate(error instanceof Error ? error.message : String(error), 300);
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
