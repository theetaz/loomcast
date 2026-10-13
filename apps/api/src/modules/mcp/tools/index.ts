import type { ModuleDeps } from "../../../deps";
import { createPasswordTokensService } from "../../auth/password-tokens";
import { createUsersService } from "../../auth/users";
import { createProjectsService } from "../../projects/service";
import { createAdminTools } from "./admin";
import { createKbTools } from "./kb";
import { createProjectTools } from "./projects";
import type { ToolDefinition } from "./registry";

export { type AdminToolsDeps, createAdminTools } from "./admin";
export { createKbTools, type KbToolsDeps, kbEntryUrl, projectIdFromCwd } from "./kb";
export { createProjectTools, type ProjectToolsDeps, projectUrl } from "./projects";
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
export function createMcpTools(deps: ModuleDeps): ToolDefinition[] {
  const { db, clock, config, sessions, tokens, kb } = deps;
  const projects = createProjectsService(deps);
  const passwordTokens = createPasswordTokensService({ db, clock, config });
  const users = createUsersService({ db, clock, sessions, tokens, passwordTokens });
  return [
    ...createProjectTools({ projects, appOrigin: config.appOrigin }),
    ...createKbTools({ kb, db, appOrigin: config.appOrigin }),
    ...createAdminTools({ users }),
  ];
}
