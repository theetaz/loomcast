import type { McpHttpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { type McpToolName, mcpTools } from "@loomcast/contracts";

/**
 * The platform's MCP server as a producer session sees it. The producer runtime names each MCP
 * tool `mcp__<server>__<tool>`, after replacing every character outside `[A-Za-z0-9_-]` in the
 * server and tool names with `_`. The platform's tool names contain dots, so `kb.search` reaches
 * the session, its permission callback and its `tool_use` blocks as `mcp__loomcast__kb_search`.
 */
export const MCP_SERVER_NAME = "loomcast";

/** The job types that run a producer session, which may get the platform's MCP server. */
export const PRODUCER_JOB_TYPES = [
  "producer.chat",
  "kb.analyze_reference",
  "content.write_script",
  "content.storyboard",
  "content.revise",
] as const;
export type ProducerJobType = (typeof PRODUCER_JOB_TYPES)[number];

/** What a production step's session may look up: the item, its format and the knowledge base. */
const PRODUCTION_READS = [
  "content.get",
  "format.get_rules",
  "kb.search",
  "kb.get",
  "project.get",
] as const satisfies readonly McpToolName[];

/**
 * The platform MCP tools each job type may call. Every other MCP tool, and every other MCP
 * server, is denied. A reference analysis only reads: its transcript is untrusted, so the session
 * must not be able to write to the knowledge base. Production steps only read too: their result
 * is returned to the studio agent, which hands it to the server, so a session never submits
 * versions or uploads assets itself.
 */
export const MCP_TOOL_ALLOW_LIST = {
  "producer.chat": [
    "kb.search",
    "kb.get",
    "kb.save_brainstorm",
    "kb.add_decision",
    "kb.add_reference",
    "project.get",
  ],
  "kb.analyze_reference": ["kb.search", "kb.get", "project.get"],
  "content.write_script": PRODUCTION_READS,
  "content.storyboard": PRODUCTION_READS,
  "content.revise": PRODUCTION_READS,
} as const satisfies Record<ProducerJobType, readonly McpToolName[]>;

/** The runtime's form of a name: every character outside `[A-Za-z0-9_-]` becomes `_`. */
export function normalizeMcpName(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, "_");
}

/** The name a producer session uses for a platform MCP tool, e.g. `mcp__loomcast__kb_search`. */
export function qualifiedToolName(tool: string): string {
  return `mcp__${normalizeMcpName(MCP_SERVER_NAME)}__${normalizeMcpName(tool)}`;
}

/** The qualified names of the MCP tools a job type may call. */
export function allowedMcpTools(jobType: ProducerJobType): readonly string[] {
  return MCP_TOOL_ALLOW_LIST[jobType].map(qualifiedToolName);
}

/**
 * The qualified names of every known platform MCP tool a job type may not call. They are removed
 * from the session outright, on top of the permission guard denying them.
 */
export function deniedMcpTools(jobType: ProducerJobType): string[] {
  const allowed = new Set(allowedMcpTools(jobType));
  return Object.keys(mcpTools)
    .map(qualifiedToolName)
    .filter((name) => !allowed.has(name));
}

/** Whether a tool name is an MCP tool of any server. */
export function isMcpToolName(name: string): boolean {
  return name.startsWith("mcp__");
}

/** The MCP access of one producer turn. */
export interface ProducerMcpAccess {
  readonly url: URL;
  /** The job token. It goes into the session's MCP configuration and nowhere else. */
  readonly token: string;
}

/**
 * The runtime's `mcpServers` option: the platform's MCP server over streamable HTTP with the
 * job token as a bearer token, or no servers at all without MCP access.
 *
 * The tools are always loaded into the session's context (`alwaysLoad`), because the session has
 * no tool-search tool through which deferred tools could be found.
 */
export function mcpServersFor(
  access: ProducerMcpAccess | undefined,
): Record<string, McpHttpServerConfig> {
  if (access === undefined) {
    return {};
  }
  return {
    [MCP_SERVER_NAME]: {
      type: "http",
      url: access.url.toString(),
      headers: { Authorization: `Bearer ${access.token}` },
      alwaysLoad: true,
    },
  };
}
