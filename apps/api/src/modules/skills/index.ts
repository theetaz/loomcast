import { GetSkillQuerySchema, routes, SkillNameSchema } from "@loomcast/contracts";
import { Hono } from "hono";
import type { ModuleDeps } from "../../deps";
import { notFound, validationFailed } from "../../lib/errors";
import { idParam, issueDetails } from "../../lib/http";
import type { AppEnv } from "../../types";
import { currentUser } from "../auth/guards";
import { serviceFor, workspaceExists } from "../content/support";
import { createSkillsService, type SkillsService, type SkillsServiceDeps } from "./service";
import { createSkillUsageService, type SkillUsageService } from "./usage";

export { skillBytes, skillDescription, toSkillSummary, toSkillVersionSummary } from "./mappers";
export {
  createSkillsService,
  type PublishSkillInput,
  type PublishSkillResult,
  type SkillActor,
  type SkillsService,
  type SkillsServiceDeps,
  skillChecksum,
} from "./service";
export {
  aggregateUsage,
  createSkillUsageService,
  itemSkillUse,
  type ProgressUsageRow,
  type SkillUsageService,
} from "./usage";

/** The app's skills service (one per deps object), for the REST routes and the MCP tools. */
export function skillsServiceFor(deps: SkillsServiceDeps): SkillsService {
  return serviceFor(deps, "skills", () => createSkillsService(deps));
}

/** The app's skill usage service: what reported production progress used. */
export function skillUsageServiceFor(deps: { db: SkillsServiceDeps["db"] }): SkillUsageService {
  return serviceFor(deps, "skillUsage", () => createSkillUsageService(deps));
}

const skillNotFound = () => notFound("No skill has that name.");

/**
 * Skill registry endpoints: the published skills and recipes producer sessions load, and their
 * immutable versions. Skills are published through MCP (`skill.publish`) or the `skills:seed`
 * command; the web app only reads them. The usage routes count what production progress
 * (`progress.report`) says each skill and tool was used for.
 */
export function register(app: Hono<AppEnv>, deps: ModuleDeps): Hono<AppEnv> {
  const skills = skillsServiceFor(deps);
  const usage = skillUsageServiceFor(deps);
  const router = new Hono<AppEnv>();

  router.get(routes["skills.list"].path, async (c) => {
    currentUser(c);
    return c.json({ items: await skills.list() }, 200);
  });

  router.get(routes["skills.versions"].path, async (c) => {
    currentUser(c);
    const items = await skills.versions(c.req.param("name"));
    if (items === null) {
      throw skillNotFound();
    }
    return c.json({ items }, 200);
  });

  router.get(routes["skills.usage"].path, async (c) => {
    currentUser(c);
    const name = SkillNameSchema.safeParse(c.req.param("name"));
    if (!name.success) {
      throw skillNotFound();
    }
    return c.json({ items: await usage.items(name.data) }, 200);
  });

  router.get(routes["skills.usageAll"].path, async (c) => {
    currentUser(c);
    return c.json({ items: await usage.all() }, 200);
  });

  router.get(routes["skills.workspace"].path, async (c) => {
    currentUser(c);
    const workspaceId = idParam(c, "workspaceId");
    if (!(await workspaceExists(deps.db, workspaceId))) {
      throw notFound("Workspace not found.");
    }
    return c.json(await usage.workspace(workspaceId), 200);
  });

  router.get(routes["skills.get"].path, async (c) => {
    currentUser(c);
    const query = GetSkillQuerySchema.safeParse(c.req.query());
    if (!query.success) {
      throw validationFailed(issueDetails(query.error));
    }
    const found = await skills.get(c.req.param("name"), query.data.version);
    if (found === null) {
      throw query.data.version === undefined
        ? skillNotFound()
        : notFound("The skill has no version with that number.");
    }
    return c.json(found, 200);
  });

  app.route("/", router);
  return router;
}
