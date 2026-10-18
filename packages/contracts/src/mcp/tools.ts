import { adminTools } from "./admin-tools";
import { calendarTools } from "./calendar-tools";
import type { McpToolContract } from "./contract";
import { kbTools } from "./kb-tools";
import { ownerTools } from "./owner-tools";
import { pipelineTools } from "./pipeline-tools";
import { postTools } from "./post-tools";
import { projectTools } from "./project-tools";

/** Every MCP tool the server registers, by name. */
export const mcpTools = {
  ...projectTools,
  ...kbTools,
  ...adminTools,
  ...pipelineTools,
  ...calendarTools,
  ...ownerTools,
  ...postTools,
} as const satisfies Record<string, McpToolContract>;

export type McpTools = typeof mcpTools;
export type McpToolName = keyof McpTools;
