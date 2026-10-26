import {
  CreateApiClientRequestSchema,
  type CreateApiClientResponse,
  routes,
  UpdateApiClientRequestSchema,
} from "@loomcast/contracts";
import { type Context, Hono } from "hono";
import type { ModuleDeps } from "../../deps";
import { audit } from "../../lib/audit";
import { forbidden, notFound } from "../../lib/errors";
import { clientIp, idParam, readJson } from "../../lib/http";
import type { AppEnv, AuthUser } from "../../types";
import { currentUser } from "../auth/guards";
import { serviceFor } from "../content/support";
import { type ApiClientsService, createApiClientsService } from "./service";

export {
  type ApiClientChange,
  type ApiClientsService,
  type CreatedApiClient,
  createApiClientsService,
} from "./service";

/** One API clients service per app, shared by these routes and the machine API. */
export function apiClientsServiceFor(deps: ModuleDeps): ApiClientsService {
  return serviceFor(deps, "apiClients", () => createApiClientsService(deps));
}

function requireOwner(c: Context<AppEnv>): AuthUser {
  const user = currentUser(c);
  if (user.role !== "owner") {
    throw forbidden("Only the owner can manage API clients.");
  }
  return user;
}

/**
 * The owner's API clients: `GET`, `POST`, `PATCH` and `DELETE /api/api-clients`. Admins get 403.
 * Every change is audited with the owner as the actor; the key is never audited or logged.
 */
export function register(app: Hono<AppEnv>, deps: ModuleDeps): Hono<AppEnv> {
  const { db, config } = deps;
  const clients = apiClientsServiceFor(deps);
  const router = new Hono<AppEnv>();

  router.get(routes["apiClients.list"].path, async (c) => {
    requireOwner(c);
    return c.json({ items: await clients.list() }, 200);
  });

  router.post(routes["apiClients.create"].path, async (c) => {
    const user = requireOwner(c);
    const input = await readJson(c, CreateApiClientRequestSchema);
    const created = await clients.create(input, user.id);
    await audit(db, {
      actorKind: "user",
      actorId: user.id,
      action: "api_client.created",
      targetType: "api_token",
      targetId: created.client.id,
      data: {
        name: created.client.name,
        workspaceId: created.client.workspaceId,
        grants: input.grants,
        expiresAt: created.client.expiresAt,
      },
      ip: clientIp(c, config.trustProxy),
    });
    // The key is in this response only; keep it out of every cache.
    c.header("Cache-Control", "no-store");
    const body: CreateApiClientResponse = { client: created.client, secret: created.secret };
    return c.json(body, 201);
  });

  router.patch(routes["apiClients.update"].path, async (c) => {
    const user = requireOwner(c);
    const id = idParam(c);
    const input = await readJson(c, UpdateApiClientRequestSchema);
    const result = await clients.update(id, input);
    if (result === null) {
      throw notFound("No API client has that id.");
    }
    if (result.changes.name !== undefined || result.changes.grants !== undefined) {
      await audit(db, {
        actorKind: "user",
        actorId: user.id,
        action: "api_client.updated",
        targetType: "api_token",
        targetId: id,
        data: result.changes,
        ip: clientIp(c, config.trustProxy),
      });
    }
    return c.json(result.client, 200);
  });

  router.delete(routes["apiClients.revoke"].path, async (c) => {
    const user = requireOwner(c);
    const id = idParam(c);
    const result = await clients.revoke(id);
    if (result === null) {
      throw notFound("No API client has that id.");
    }
    if (result.revoked) {
      await audit(db, {
        actorKind: "user",
        actorId: user.id,
        action: "api_client.revoked",
        targetType: "api_token",
        targetId: id,
        data: { name: result.client.name },
        ip: clientIp(c, config.trustProxy),
      });
    }
    return c.body(null, 204);
  });

  app.route("/", router);
  return router;
}
