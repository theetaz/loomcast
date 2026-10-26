import { CreateFormatRequestSchema, routes, UpdateFormatRequestSchema } from "@loomcast/contracts";
import { Hono } from "hono";
import type { ModuleDeps } from "../../deps";
import { notFound } from "../../lib/errors";
import { idParam, readJson } from "../../lib/http";
import type { AppEnv } from "../../types";
import { currentUser } from "../auth/guards";
import { userActor } from "../content/actor";
import { serviceFor } from "../content/support";
import { createFormatsService, type FormatsService, type FormatsServiceDeps } from "./service";

export {
  createFormatsService,
  currentFormatVersionId,
  FALLBACK_FORMAT_SLUG,
  type FormatsService,
  type FormatsServiceDeps,
  toFormat,
  toFormatVersion,
  type WriteOptions,
} from "./service";

/** The app's formats service (one per deps object), for other modules and the MCP tools. */
export function formatsServiceFor(deps: FormatsServiceDeps): FormatsService {
  return serviceFor(deps, "formats", () => createFormatsService(deps));
}

const formatNotFound = () => notFound("No format has that id.");
const workspaceNotFound = () => notFound("Workspace not found.");

/**
 * Format endpoints: the formats of a workspace and their versioned rules. Every update stores a new
 * immutable version and moves the format's current version; a stale `baseVersionId` is a 409.
 */
export function register(app: Hono<AppEnv>, deps: ModuleDeps): Hono<AppEnv> {
  const formats = formatsServiceFor(deps);
  const router = new Hono<AppEnv>();
  const trustProxy = deps.config.trustProxy;

  router.get(routes["formats.list"].path, async (c) => {
    currentUser(c);
    const items = await formats.list(idParam(c, "workspaceId"));
    if (items === null) {
      throw workspaceNotFound();
    }
    return c.json({ items }, 200);
  });

  router.post(routes["formats.create"].path, async (c) => {
    const workspaceId = idParam(c, "workspaceId");
    const input = await readJson(c, CreateFormatRequestSchema);
    const format = await formats.create(workspaceId, input, userActor(c, trustProxy));
    return c.json(format, 201);
  });

  router.get(routes["formats.get"].path, async (c) => {
    currentUser(c);
    const format = await formats.get(idParam(c));
    if (format === null) {
      throw formatNotFound();
    }
    return c.json(format, 200);
  });

  router.patch(routes["formats.update"].path, async (c) => {
    const id = idParam(c);
    const input = await readJson(c, UpdateFormatRequestSchema);
    const format = await formats.update(id, input, userActor(c, trustProxy));
    if (format === null) {
      throw formatNotFound();
    }
    return c.json(format, 200);
  });

  router.get(routes["formats.versions"].path, async (c) => {
    currentUser(c);
    const items = await formats.versions(idParam(c));
    if (items === null) {
      throw formatNotFound();
    }
    return c.json({ items }, 200);
  });

  app.route("/", router);
  return router;
}
