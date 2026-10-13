import type { ModuleDeps } from "../../../deps";
import { createPasswordTokensService } from "../../auth/password-tokens";
import { createUsersService } from "../../auth/users";
import { contentServiceFor } from "../../content";
import { formatsServiceFor } from "../../formats";
import { createProjectsService } from "../../projects/service";
import { seriesServiceFor } from "../../series";
import { skillsServiceFor } from "../../skills";
import { createAdminTools } from "./admin";
import { createAssetTools } from "./assets";
import { createCalendarTools } from "./calendar";
import { createKbTools } from "./kb";
import { createPipelineTools } from "./pipeline";
import { createProjectTools } from "./projects";
import type { ToolDefinition } from "./registry";
import { createSkillTools } from "./skills";

export { type AdminToolsDeps, createAdminTools } from "./admin";
export { type AssetToolsDeps, createAssetTools } from "./assets";
export { type CalendarToolsDeps, createCalendarTools } from "./calendar";
export { createKbTools, type KbToolsDeps, kbEntryUrl, projectIdFromCwd } from "./kb";
export { createPipelineTools, type PipelineToolsDeps, tokenActor } from "./pipeline";
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
export { createSkillTools, type SkillToolsDeps } from "./skills";

/**
 * Every tool served on `/mcp`. A new group of tools lives in its own file under `tools/`, built
 * with `defineTool` from its contract in `@loomcast/contracts`, and is added here.
 */
export function createMcpTools(deps: ModuleDeps): ToolDefinition[] {
  const { db, bus, clock, config, sessions, tokens, kb } = deps;
  const projects = createProjectsService(deps);
  const passwordTokens = createPasswordTokensService({ db, clock, config });
  const users = createUsersService({ db, bus, clock, sessions, tokens, passwordTokens });
  const content = contentServiceFor(deps);
  return [
    ...createProjectTools({ projects, appOrigin: config.appOrigin }),
    ...createKbTools({ kb, db, appOrigin: config.appOrigin }),
    ...createAdminTools({ users }),
    ...createPipelineTools({
      db,
      content,
      formats: formatsServiceFor(deps),
      series: seriesServiceFor(deps),
    }),
    ...createAssetTools({ assets: deps.assets, content }),
    ...createSkillTools({ skills: skillsServiceFor(deps) }),
    ...createCalendarTools({ db, series: seriesServiceFor(deps) }),
  ];
}
