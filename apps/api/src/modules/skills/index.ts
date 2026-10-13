import { GetSkillQuerySchema, routes } from "@loomcast/contracts";
import { Hono } from "hono";
import type { ModuleDeps } from "../../deps";
import { notFound, validationFailed } from "../../lib/errors";
import { issueDetails } from "../../lib/http";
import type { AppEnv } from "../../types";
import { currentUser } from "../auth/guards";
import { serviceFor } from "../content/support";
import { createSkillsService, type SkillsService, type SkillsServiceDeps } from "./service";

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

/** The app's skills service (one per deps object), for the REST routes and the MCP tools. */
export function skillsServiceFor(deps: SkillsServiceDeps): SkillsService {
  return serviceFor(deps, "skills", () => createSkillsService(deps));
}

const skillNotFound = () => notFound("No skill has that name.");

/**
 * Skill registry endpoints: the published skills and recipes producer sessions load, and their
 * immutable versions. Skills are published through MCP (`skill.publish`) or the `skills:seed`
 * command; the web app only reads them.
 */
export function register(app: Hono<AppEnv>, deps: ModuleDeps): Hono<AppEnv> {
  const skills = skillsServiceFor(deps);
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
