import type { ModuleDeps } from "../../../deps";
import { createPasswordTokensService } from "../../auth/password-tokens";
import { createUsersService } from "../../auth/users";
import { calendarServiceFor } from "../../calendar";
import { listChannels } from "../../channels/mappers";
import { contentServiceFor } from "../../content";
import { formatsServiceFor } from "../../formats";
import { reviewsServiceFor } from "../../reviews";
import { seriesServiceFor } from "../../series";
import { skillsServiceFor } from "../../skills";
import { createWorkspacesService } from "../../workspaces/service";
import { createAdminTools } from "./admin";
import { createAssetTools } from "./assets";
import { createCalendarTools } from "./calendar";
import { createKbTools } from "./kb";
import { createOwnerTools } from "./owner";
import { createPipelineTools } from "./pipeline";
import { createPostTools } from "./posts";
import type { ToolDefinition } from "./registry";
import { createSkillTools } from "./skills";
import { createWorkspaceTools } from "./workspaces";

export { type AdminToolsDeps, createAdminTools } from "./admin";
export { type AssetToolsDeps, createAssetTools } from "./assets";
export { type CalendarToolsDeps, createCalendarTools } from "./calendar";
export { createKbTools, type KbToolsDeps, kbEntryUrl, workspaceIdFromCwd } from "./kb";
export { createOwnerTools, type OwnerToolsDeps } from "./owner";
export { createPipelineTools, type PipelineToolsDeps, tokenActor } from "./pipeline";
export { createPostTools, type PostToolsDeps } from "./posts";
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
export { createWorkspaceTools, type WorkspaceToolsDeps, workspaceUrl } from "./workspaces";

/**
 * Every tool served on `/mcp`. A new group of tools lives in its own file under `tools/`, built
 * with `defineTool` from its contract in `@loomcast/contracts`, and is added here.
 */
export function createMcpTools(deps: ModuleDeps): ToolDefinition[] {
  const { db, bus, clock, config, sessions, tokens, kb } = deps;
  const workspaces = createWorkspacesService(deps);
  const passwordTokens = createPasswordTokensService({ db, clock, config });
  const users = createUsersService({ db, bus, clock, sessions, tokens, passwordTokens });
  const content = contentServiceFor(deps);
  return [
    ...createWorkspaceTools({ workspaces, appOrigin: config.appOrigin }),
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
    ...createOwnerTools({
      content,
      reviews: reviewsServiceFor(deps),
      calendar: calendarServiceFor(deps),
      listChannels: (workspaceId) => listChannels(db, config, workspaceId),
    }),
    ...createPostTools({
      db,
      content,
      reviews: reviewsServiceFor(deps),
      calendar: calendarServiceFor(deps),
      assets: deps.assets,
    }),
  ];
}
