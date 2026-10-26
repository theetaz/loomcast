import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/** Name the server reports to clients during `initialize`. */
export const MCP_SERVER_NAME = "loomcast";
export const MCP_SERVER_VERSION = "0.1.0";

const INSTRUCTIONS = [
  "Loomcast plans, renders and publishes short tech videos.",
  "Workspaces group everything one brand publishes: call workspace.list or",
  "workspace.get first to find the workspace id or slug the other tools need.",
].join(" ");

/**
 * A server for one request. The endpoint is stateless, so every request gets a fresh server and
 * registers the tools bound to that request's caller.
 */
export function createMcpServer(): McpServer {
  return new McpServer(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    { instructions: INSTRUCTIONS },
  );
}
