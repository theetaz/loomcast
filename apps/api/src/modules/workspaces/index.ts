import {
  CreateWorkspaceSchema,
  ListWorkspacesQuerySchema,
  routes,
  SetWorkspaceIconSchema,
  UpdateWorkspaceSchema,
} from "@loomcast/contracts";
import { channels } from "@loomcast/db";
import { and, eq, sql } from "drizzle-orm";
import { type Context, Hono } from "hono";
import type { ModuleDeps } from "../../deps";
import { notFound, validationFailed } from "../../lib/errors";
import { clientIp, idParam, issueDetails, readJson } from "../../lib/http";
import { fetchPicture } from "../../lib/pictures";
import type { AppEnv } from "../../types";
import { currentUser } from "../auth/guards";
import { iconProblem, sniffIconMime } from "./icon";
import { createWorkspacesService, type WorkspaceActor } from "./service";

export {
  baseSlug,
  createWorkspacesService,
  FALLBACK_SLUG,
  type ListWorkspacesOptions,
  slugWithSuffix,
  toWorkspace,
  type WorkspaceActor,
  type WorkspaceIcon,
  type WorkspacesService,
  type WorkspacesServiceDeps,
  workspaceIconPath,
} from "./service";

const workspaceNotFound = () => notFound("No workspace has that id or slug.");

/**
 * Workspace endpoints: list, create, get and update by id or slug, archive, and the icon. Every
 * write runs in a transaction with its audit row and publishes `workspace.created` or
 * `workspace.updated` once committed. The MCP tools use the same service
 * (`createWorkspacesService`).
 */
export function register(app: Hono<AppEnv>, deps: ModuleDeps): Hono<AppEnv> {
  const { db } = deps;
  const workspaces = createWorkspacesService(deps);
  const router = new Hono<AppEnv>();

  function actor(c: Context<AppEnv>): WorkspaceActor {
    const user = currentUser(c);
    return { kind: "user", id: user.id, userId: user.id, ip: clientIp(c, deps.config.trustProxy) };
  }

  router.get(routes["workspaces.list"].path, async (c) => {
    currentUser(c);
    const query = ListWorkspacesQuerySchema.safeParse(c.req.query());
    if (!query.success) {
      throw validationFailed(issueDetails(query.error));
    }
    const items = await workspaces.list(query.data);
    return c.json({ items }, 200);
  });

  router.post(routes["workspaces.create"].path, async (c) => {
    const input = await readJson(c, CreateWorkspaceSchema);
    const workspace = await workspaces.create(input, actor(c));
    return c.json(workspace, 201);
  });

  router.get(routes["workspaces.get"].path, async (c) => {
    currentUser(c);
    const workspace = await workspaces.get(c.req.param("idOrSlug"));
    if (workspace === null) {
      throw workspaceNotFound();
    }
    return c.json(workspace, 200);
  });

  router.patch(routes["workspaces.update"].path, async (c) => {
    const input = await readJson(c, UpdateWorkspaceSchema);
    const workspace = await workspaces.update(c.req.param("idOrSlug"), input, actor(c));
    if (workspace === null) {
      throw workspaceNotFound();
    }
    return c.json(workspace, 200);
  });

  router.post(routes["workspaces.archive"].path, async (c) => {
    const id = idParam(c);
    const workspace = await workspaces.archive(id, actor(c));
    if (workspace === null) {
      throw workspaceNotFound();
    }
    return c.json(workspace, 200);
  });

  router.get(routes["workspaces.icon"].path, async (c) => {
    currentUser(c);
    const icon = await workspaces.icon(idParam(c));
    if (icon === null) {
      throw notFound("That workspace has no icon.");
    }
    // The URL carries the icon's version, so the browser may keep it.
    return new Response(icon.body, {
      status: 200,
      headers: {
        "Content-Type": icon.mime,
        "Content-Length": String(icon.body.byteLength),
        "Cache-Control": "private, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });

  router.put(routes["workspaces.setIcon"].path, async (c) => {
    const id = idParam(c);
    const who = actor(c);
    const input = await readJson(c, SetWorkspaceIconSchema);
    let body: Uint8Array;
    if ("data" in input) {
      body = Buffer.from(input.data, "base64");
      const problem = iconProblem(body);
      if (problem !== null) {
        throw validationFailed([{ path: "data", message: problem }]);
      }
    } else {
      // The picture of one of the workspace's own channels, fetched from the platform.
      const [channel] = await db
        .select({ picture: sql<string | null>`${channels.meta}->>'picture'` })
        .from(channels)
        .where(and(eq(channels.id, input.fromChannelId), eq(channels.workspaceId, id)))
        .limit(1);
      if (channel === undefined) {
        throw validationFailed([
          { path: "fromChannelId", message: "No channel of this workspace has that id" },
        ]);
      }
      const picture =
        channel.picture === null
          ? null
          : await fetchPicture(channel.picture, { signal: c.req.raw.signal });
      if (picture === null) {
        throw validationFailed([
          { path: "fromChannelId", message: "That channel's picture could not be loaded" },
        ]);
      }
      body = picture.body;
      const problem = iconProblem(body);
      if (problem !== null) {
        throw validationFailed([{ path: "fromChannelId", message: problem }]);
      }
    }
    const mime = sniffIconMime(body);
    if (mime === null) {
      throw validationFailed([{ path: "data", message: "Use a PNG, JPEG or WebP image." }]);
    }
    const workspace = await workspaces.setIcon(id, { body, mime }, who);
    if (workspace === null) {
      throw workspaceNotFound();
    }
    return c.json(workspace, 200);
  });

  router.delete(routes["workspaces.clearIcon"].path, async (c) => {
    const workspace = await workspaces.setIcon(idParam(c), null, actor(c));
    if (workspace === null) {
      throw workspaceNotFound();
    }
    return c.json(workspace, 200);
  });

  app.route("/", router);
  return router;
}
