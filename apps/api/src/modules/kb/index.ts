import {
  CaptureConversationSchema,
  CreateKbEntrySchema,
  KbSearchQuerySchema,
  ListKbQuerySchema,
  routes,
  UpdateKbEntrySchema,
} from "@loomcast/contracts";
import { type Context, Hono } from "hono";
import type { ModuleDeps } from "../../deps";
import { notFound, validationFailed } from "../../lib/errors";
import { clientIp, idParam, issueDetails, readJson } from "../../lib/http";
import type { AppEnv } from "../../types";
import { currentUser } from "../auth/guards";
import { toJobSummary } from "../jobs/service";
import type { KbActor } from "./service";
import { withNormalizedTags } from "./tags";

export { type EntryRow, entryColumns, toKbEntry, toKbEntryDetail } from "./mappers";
export {
  type AnalyzeResult,
  analysisKey,
  createKbService,
  type KbActor,
  type KbSearchOptions,
  type KbService,
  type KbServiceDeps,
  mediaAnalysisKey,
  type NewDecisionEntry,
  type NewKbEntry,
  type NewTextEntry,
  type SessionSummaryInput,
  type SessionSummaryResult,
} from "./service";
export { normalizeTag, normalizeTags } from "./tags";

const entryNotFound = () => notFound("No knowledge base entry has that id.");
const projectNotFound = () => notFound("Project not found.");

const CreateBodySchema = withNormalizedTags(CreateKbEntrySchema);
const CaptureBodySchema = withNormalizedTags(CaptureConversationSchema);
const UpdateBodySchema = withNormalizedTags(UpdateKbEntrySchema);

/**
 * The query string as an object, with keys that may repeat (`kinds=a&kinds=b`) kept as arrays
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
 * Knowledge-base endpoints: entries of a project (list, create, capture from a conversation,
 * tags) and single entries (get, update, delete). Every write runs in a transaction with its
 * audit row and publishes a `kb.entry.*` event once committed. The MCP tools use the same service
 * through `deps.kb`.
 */
export function register(app: Hono<AppEnv>, deps: ModuleDeps): Hono<AppEnv> {
  const { kb } = deps;
  const router = new Hono<AppEnv>();

  function actor(c: Context<AppEnv>): KbActor {
    const user = currentUser(c);
    return {
      kind: "user",
      id: user.id,
      userId: user.id,
      via: "ui",
      ip: clientIp(c, deps.config.trustProxy),
    };
  }

  router.get(routes["kb.list"].path, async (c) => {
    currentUser(c);
    const projectId = idParam(c, "projectId");
    const query = ListKbQuerySchema.safeParse(queryObject(c, ["kinds"]));
    if (!query.success) {
      throw validationFailed(issueDetails(query.error));
    }
    const page = await kb.list(projectId, query.data);
    if (page === null) {
      throw projectNotFound();
    }
    return c.json(page, 200);
  });

  router.post(routes["kb.create"].path, async (c) => {
    const projectId = idParam(c, "projectId");
    const input = await readJson(c, CreateBodySchema);
    const entry = await kb.create(projectId, input, actor(c));
    return c.json(entry, 201);
  });

  router.post(routes["kb.capture"].path, async (c) => {
    const projectId = idParam(c, "projectId");
    const input = await readJson(c, CaptureBodySchema);
    const entry = await kb.capture(projectId, input, actor(c));
    return c.json(entry, 201);
  });

  router.get(routes["kb.tags"].path, async (c) => {
    currentUser(c);
    const items = await kb.tags(idParam(c, "projectId"));
    if (items === null) {
      throw projectNotFound();
    }
    return c.json({ items }, 200);
  });

  // Registered before `/api/kb/:id`, which would otherwise take `search` as an id.
  router.get(routes["kb.search"].path, async (c) => {
    currentUser(c);
    const query = KbSearchQuerySchema.safeParse(queryObject(c, ["kinds"]));
    if (!query.success) {
      throw validationFailed(issueDetails(query.error));
    }
    const items = await kb.search(query.data);
    return c.json({ items }, 200);
  });

  router.get(routes["kb.get"].path, async (c) => {
    currentUser(c);
    const entry = await kb.get(idParam(c));
    if (entry === null) {
      throw entryNotFound();
    }
    return c.json(entry, 200);
  });

  router.patch(routes["kb.update"].path, async (c) => {
    const id = idParam(c);
    const input = await readJson(c, UpdateBodySchema);
    const entry = await kb.update(id, input, actor(c));
    if (entry === null) {
      throw entryNotFound();
    }
    return c.json(entry, 200);
  });

  router.post(routes["kb.analyze"].path, async (c) => {
    const result = await kb.analyze(idParam(c), actor(c));
    if (result === null) {
      throw entryNotFound();
    }
    return c.json(toJobSummary(result.job), 201);
  });

  router.delete(routes["kb.delete"].path, async (c) => {
    const deleted = await kb.softDelete(idParam(c), actor(c));
    if (!deleted) {
      throw entryNotFound();
    }
    return c.body(null, 204);
  });

  app.route("/", router);
  return router;
}
