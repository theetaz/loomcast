import { CreateTokenRequestSchema, type CreateTokenResponse, routes } from "@loomcast/contracts";
import { Hono } from "hono";
import type { ModuleDeps } from "../../deps";
import { audit } from "../../lib/audit";
import { notFound } from "../../lib/errors";
import { clientIp, idParam, readJson } from "../../lib/http";
import type { AppEnv } from "../../types";
import { currentUser } from "../auth/guards";
import { toAccessToken } from "./service";

export {
  ALLOWED_SCOPES,
  type CreatedToken,
  type CreateTokenInput,
  createTokensService,
  hasScopes,
  jobTokenName,
  type MintedJobToken,
  type MintJobTokenInput,
  OWNER_ONLY_SCOPES,
  revokeJobTokens,
  type TokensService,
  toAccessToken,
} from "./service";

/**
 * MCP access tokens of the signed-in user: `GET`, `POST` and `DELETE /api/tokens`. Device tokens
 * are created by pairing and revoked with their device, and job tokens are minted and revoked by
 * the job dispatcher and lifecycle, so these routes never list or touch either.
 */
export function register(app: Hono<AppEnv>, deps: ModuleDeps): Hono<AppEnv> {
  const { db, config, tokens } = deps;
  const router = new Hono<AppEnv>();

  router.get(routes["tokens.list"].path, async (c) => {
    const user = currentUser(c);
    const rows = await tokens.list(user.id, "mcp");
    return c.json({ items: rows.map(toAccessToken) }, 200);
  });

  router.post(routes["tokens.create"].path, async (c) => {
    const user = currentUser(c);
    const input = await readJson(c, CreateTokenRequestSchema);
    const created = await tokens.create({
      userId: user.id,
      kind: "mcp",
      name: input.name,
      scopes: input.scopes,
      expiresAt: input.expiresAt === undefined ? null : new Date(input.expiresAt),
    });
    await audit(db, {
      actorKind: "user",
      actorId: user.id,
      action: "token.created",
      targetType: "api_token",
      targetId: created.row.id,
      data: { kind: "mcp", name: created.row.name, scopes: created.row.scopes },
      ip: clientIp(c, config.trustProxy),
    });
    // The secret is in this response only; keep it out of every cache.
    c.header("Cache-Control", "no-store");
    const body: CreateTokenResponse = { token: created.token, secret: created.secret };
    return c.json(body, 201);
  });

  router.delete(routes["tokens.revoke"].path, async (c) => {
    const user = currentUser(c);
    const id = idParam(c);
    const result = await tokens.revoke(id, { userId: user.id, kind: "mcp" });
    if (result === null) {
      throw notFound("Token not found.");
    }
    if (result.revoked) {
      await audit(db, {
        actorKind: "user",
        actorId: user.id,
        action: "token.revoked",
        targetType: "api_token",
        targetId: id,
        data: { kind: "mcp" },
        ip: clientIp(c, config.trustProxy),
      });
    }
    return c.body(null, 204);
  });

  app.route("/", router);
  return router;
}
