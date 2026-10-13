import type { ModuleDeps } from "../../../deps";
import type { ToolDefinition } from "./registry";

export {
  defineTool,
  McpToolError,
  type ResolveContext,
  registerTools,
  TOOL_CALL_AUDIT_ACTION,
  type ToolCallContext,
  type ToolContext,
  type ToolDefinition,
  type ToolImplementation,
} from "./registry";

/**
 * Every tool served on `/mcp`. A new group of tools lives in its own file under `tools/`, built
 * with `defineTool` from its contract in `@loomcast/contracts`, and is added here.
 */
export function createMcpTools(_deps: ModuleDeps): ToolDefinition[] {
  return [];
}
