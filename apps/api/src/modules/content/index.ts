import {
  CreateContentItemRequestSchema,
  EditVersionRequestSchema,
  ListContentQuerySchema,
  routes,
  SubmitContentRequestSchema,
  UpdateContentItemRequestSchema,
} from "@loomcast/contracts";
import { type Context, Hono } from "hono";
import type { ModuleDeps } from "../../deps";
import { notFound, validationFailed } from "../../lib/errors";
import { idParam, issueDetails, readJson } from "../../lib/http";
import type { AppEnv } from "../../types";
import { currentUser } from "../auth/guards";
import { userActor } from "./actor";
import { type ContentService, type ContentServiceDeps, createContentService } from "./service";
import { serviceFor } from "./support";

export {
  auditActor,
  itemViaFor,
  type PipelineActor,
  SYSTEM_ACTOR,
  userActor,
  versionViaFor,
} from "./actor";
export { toContentItem, toContentVersion, toContentVersionSummary } from "./mappers";
export { PRODUCTION_JOB_TYPES } from "./queries";
export {
  type ContentService,
  type ContentServiceDeps,
  type CreateItemOptions,
  createContentService,
  type ItemTracking,
  type JobVersionOptions,
  type WriteOptions,
} from "./service";
export { invalidTransition, missingArtifact, staleVersion } from "./support";
export type { TransitionOptions } from "./transitions";
export {
  applyChanges,
  type CreateVersionOptions,
  type VersionChanges,
  type VersionResult,
} from "./versions";

/**
 * The app's content service (one per deps object). Production, the MCP tools and the calendar
 * use it for every item write, so all state changes go through its `transition`.
 */
export function contentServiceFor(deps: ContentServiceDeps): ContentService {
  return serviceFor(deps, "content", () => createContentService(deps));
}

const itemNotFound = () => notFound("No content item has that id.");

/**
 * The query string as an object, with keys that may repeat (`states=a&states=b`) kept as arrays
 * when they do.
 */
function queryObject(c: Context<AppEnv>, repeatable: readonly string[]): Record<string, unknown> {
  const query: Record<string, unknown> = { ...c.req.query() };
  for (const key of repeatable) {
    const values = c.req.queries(key);
    if (values !== undefined && values.length > 1) {
      query[key] = values;
    }
  }
  return query;
}

/**
 * Content item endpoints: items, their immutable versions and edits, submitting to review,
 * archive and restore. Every state change goes through the content service's transitions.
 * Production actions and the item's conversation belong to the production module; the asset list
 * to the assets module.
 */
export function register(app: Hono<AppEnv>, deps: ModuleDeps): Hono<AppEnv> {
  const content = contentServiceFor(deps);
  const router = new Hono<AppEnv>();
  const trustProxy = deps.config.trustProxy;

  router.get(routes["content.list"].path, async (c) => {
    currentUser(c);
    const query = ListContentQuerySchema.safeParse(queryObject(c, ["states"]));
    if (!query.success) {
      throw validationFailed(issueDetails(query.error));
    }
    const page = await content.list(query.data);
    if (page === null) {
      throw notFound("Workspace not found.");
    }
    return c.json(page, 200);
  });

  router.post(routes["content.create"].path, async (c) => {
    const workspaceId = idParam(c, "workspaceId");
    const input = await readJson(c, CreateContentItemRequestSchema);
    const created = await content.create(workspaceId, input, userActor(c, trustProxy));
    return c.json(created, 201);
  });

  router.get(routes["content.get"].path, async (c) => {
    currentUser(c);
    const found = await content.get(idParam(c));
    if (found === null) {
      throw itemNotFound();
    }
    return c.json(found, 200);
  });

  router.patch(routes["content.update"].path, async (c) => {
    const id = idParam(c);
    const input = await readJson(c, UpdateContentItemRequestSchema);
    const item = await content.update(id, input, userActor(c, trustProxy));
    if (item === null) {
      throw itemNotFound();
    }
    return c.json(item, 200);
  });

  router.get(routes["content.versions.list"].path, async (c) => {
    currentUser(c);
    const items = await content.versions(idParam(c));
    if (items === null) {
      throw itemNotFound();
    }
    return c.json({ items }, 200);
  });

  router.get(routes["content.versions.get"].path, async (c) => {
    currentUser(c);
    const version = await content.getVersion(idParam(c), idParam(c, "versionId"));
    if (version === null) {
      throw notFound("The item has no version with that id.");
    }
    return c.json(version, 200);
  });

  router.post(routes["content.versions.edit"].path, async (c) => {
    const id = idParam(c);
    const input = await readJson(c, EditVersionRequestSchema);
    const result = await content.edit(id, input, userActor(c, trustProxy));
    return c.json(result, 201);
  });

  router.post(routes["content.submit"].path, async (c) => {
    const input = await readJson(c, SubmitContentRequestSchema);
    const item = await content.submit(idParam(c), input, userActor(c, trustProxy));
    return c.json(item, 200);
  });

  router.post(routes["content.archive"].path, async (c) => {
    const item = await content.archive(idParam(c), userActor(c, trustProxy));
    return c.json(item, 200);
  });

  router.post(routes["content.restore"].path, async (c) => {
    const item = await content.restore(idParam(c), userActor(c, trustProxy));
    return c.json(item, 200);
  });

  app.route("/", router);
  return router;
}
