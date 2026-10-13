import {
  AssetUrlQuerySchema,
  CreateUploadRequestSchema,
  FinalizeAssetRequestSchema,
  ListItemAssetsQuerySchema,
  routes,
} from "@loomcast/contracts";
import { type Context, Hono } from "hono";
import type { z } from "zod";
import type { ModuleDeps } from "../../deps";
import { badRequest, notFound, validationFailed } from "../../lib/errors";
import { clientIp, idParam, issueDetails, readJson } from "../../lib/http";
import type { AppEnv } from "../../types";
import { currentUser } from "../auth/guards";
import type { AssetActor } from "./service";

export { toAsset, toAssetDetail } from "./mappers";
export {
  type AssetActor,
  type AssetsService,
  type AssetsServiceDeps,
  type CreateUploadInput,
  type CreateUploadResult,
  createAssetsService,
  hashStream,
  PENDING_UPLOAD_TTL_MS,
  storageUnavailable,
  type VerificationFailure,
} from "./service";

const assetNotFound = () => notFound("No asset has that id.");

function parseQuery<S extends z.ZodType>(c: Context<AppEnv>, schema: S): z.output<S> {
  const parsed = schema.safeParse(c.req.query());
  if (!parsed.success) {
    throw validationFailed(issueDetails(parsed.error));
  }
  return parsed.data;
}

/** Like `readJson`, but an empty body counts as `{}`: finalize has only optional fields. */
async function readOptionalJson<S extends z.ZodType>(
  c: Context<AppEnv>,
  schema: S,
): Promise<z.output<S>> {
  const text = await c.req.text();
  let body: unknown = {};
  if (text.trim() !== "") {
    try {
      body = JSON.parse(text);
    } catch {
      throw badRequest("The request body must be valid JSON.");
    }
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw validationFailed(issueDetails(parsed.error));
  }
  return parsed.data;
}

/**
 * Asset endpoints. The bytes never pass through the API: `POST /api/assets/uploads` returns a
 * presigned PUT to object storage, the client uploads, and `POST /api/assets/:id/finalize`
 * verifies the stored size and SHA-256. Reads return metadata or a presigned GET URL. The MCP
 * tools use the same service through `deps.assets`.
 *
 * The recurring `assets.cleanup` scheduled task (hourly) deletes pending uploads older than 24
 * hours.
 */
export function register(app: Hono<AppEnv>, deps: ModuleDeps): Hono<AppEnv> {
  const { assets } = deps;
  const router = new Hono<AppEnv>();

  function actor(c: Context<AppEnv>): AssetActor {
    const user = currentUser(c);
    return {
      kind: "user",
      id: user.id,
      userId: user.id,
      ip: clientIp(c, deps.config.trustProxy),
    };
  }

  router.post(routes["assets.createUpload"].path, async (c) => {
    const input = await readJson(c, CreateUploadRequestSchema);
    const result = await assets.createUpload(input, actor(c));
    // 201 even when an existing asset is returned, as the contract fixes one status per route.
    return c.json({ asset: result.asset, upload: result.upload }, 201);
  });

  router.post(routes["assets.finalize"].path, async (c) => {
    const id = idParam(c);
    const input = await readOptionalJson(c, FinalizeAssetRequestSchema);
    const asset = await assets.finalize(id, input, actor(c));
    if (asset === null) {
      throw assetNotFound();
    }
    return c.json(asset, 200);
  });

  router.get(routes["assets.get"].path, async (c) => {
    currentUser(c);
    const asset = await assets.get(idParam(c));
    if (asset === null) {
      throw assetNotFound();
    }
    return c.json(asset, 200);
  });

  router.get(routes["assets.url"].path, async (c) => {
    currentUser(c);
    const id = idParam(c);
    const url = await assets.url(id, parseQuery(c, AssetUrlQuerySchema));
    if (url === null) {
      throw assetNotFound();
    }
    c.header("Cache-Control", "no-store");
    return c.json(url, 200);
  });

  router.get(routes["content.assets"].path, async (c) => {
    currentUser(c);
    const items = await assets.listForItem(idParam(c), parseQuery(c, ListItemAssetsQuerySchema));
    if (items === null) {
      throw notFound("No content item has that id.");
    }
    return c.json({ items }, 200);
  });

  deps.scheduler.register("assets.cleanup", async ({ logger }) => {
    const deleted = await assets.cleanupPendingUploads();
    logger.debug({ deleted }, "pending upload cleanup finished");
  });

  app.route("/", router);
  return router;
}
