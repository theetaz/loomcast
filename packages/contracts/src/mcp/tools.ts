import { adminTools } from "./admin-tools";
import type { McpToolContract } from "./contract";
import { kbTools } from "./kb-tools";
import { projectTools } from "./project-tools";

/** Every MCP tool the server registers, by name. */
export const mcpTools = {
  ...projectTools,
  ...kbTools,
  ...adminTools,
} as const satisfies Record<string, McpToolContract>;

export type McpTools = typeof mcpTools;
export type McpToolName = keyof McpTools;
