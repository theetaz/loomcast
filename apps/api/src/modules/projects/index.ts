import {
  CreateProjectSchema,
  ListProjectsQuerySchema,
  routes,
  UpdateProjectSchema,
} from "@loomcast/contracts";
import { type Context, Hono } from "hono";
import type { ModuleDeps } from "../../deps";
import { notFound, validationFailed } from "../../lib/errors";
import { clientIp, idParam, issueDetails, readJson } from "../../lib/http";
import type { AppEnv } from "../../types";
import { currentUser } from "../auth/guards";
import { createProjectsService, type ProjectActor } from "./service";

export {
  baseSlug,
  createProjectsService,
  FALLBACK_SLUG,
  type ListProjectsOptions,
  type ProjectActor,
  type ProjectsService,
  type ProjectsServiceDeps,
  slugWithSuffix,
  toProject,
} from "./service";

const projectNotFound = () => notFound("No project has that id or slug.");

/**
 * Project endpoints: list, create, get and update by id or slug, and archive. Every write runs in
 * a transaction with its audit row and publishes `project.created` or `project.updated` once
 * committed. The MCP tools use the same service (`createProjectsService`).
 */
export function register(app: Hono<AppEnv>, deps: ModuleDeps): Hono<AppEnv> {
  const projects = createProjectsService(deps);
  const router = new Hono<AppEnv>();

  function actor(c: Context<AppEnv>): ProjectActor {
    const user = currentUser(c);
    return { kind: "user", id: user.id, userId: user.id, ip: clientIp(c, deps.config.trustProxy) };
  }

  router.get(routes["projects.list"].path, async (c) => {
    currentUser(c);
    const query = ListProjectsQuerySchema.safeParse(c.req.query());
    if (!query.success) {
      throw validationFailed(issueDetails(query.error));
    }
    const items = await projects.list(query.data);
    return c.json({ items }, 200);
  });

  router.post(routes["projects.create"].path, async (c) => {
    const input = await readJson(c, CreateProjectSchema);
    const project = await projects.create(input, actor(c));
    return c.json(project, 201);
  });

  router.get(routes["projects.get"].path, async (c) => {
    currentUser(c);
    const project = await projects.get(c.req.param("idOrSlug"));
    if (project === null) {
      throw projectNotFound();
    }
    return c.json(project, 200);
  });

  router.patch(routes["projects.update"].path, async (c) => {
    const input = await readJson(c, UpdateProjectSchema);
    const project = await projects.update(c.req.param("idOrSlug"), input, actor(c));
    if (project === null) {
      throw projectNotFound();
    }
    return c.json(project, 200);
  });

  router.post(routes["projects.archive"].path, async (c) => {
    const id = idParam(c);
    const project = await projects.archive(id, actor(c));
    if (project === null) {
      throw projectNotFound();
    }
    return c.json(project, 200);
  });

  app.route("/", router);
  return router;
}
