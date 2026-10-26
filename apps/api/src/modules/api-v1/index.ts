import {
  API_V1_PREFIX,
  API_V1_RATE_LIMIT,
  type ApiV1Channel,
  type ApiV1Me,
  CreateApiPostRequestSchema,
  FinalizeApiPostRequestSchema,
  IdempotencyKeySchema,
  ListApiPostsQuerySchema,
  PLATFORM_FORMATS,
  postFormatCatalog,
  RescheduleApiPostRequestSchema,
  routes,
} from "@loomcast/contracts";
import { apiTokens, channels, type Database, workspaces } from "@loomcast/db";
import { asc, eq, inArray } from "drizzle-orm";
import { type Context, Hono } from "hono";
import type { z } from "zod";
import type { ModuleDeps } from "../../deps";
import { audit } from "../../lib/audit";
import { badRequest, forbidden, HttpError, rateLimited, validationFailed } from "../../lib/errors";
import { clientIp, idParam, issueDetails, readJson } from "../../lib/http";
import { createRateLimiter } from "../../lib/rate-limit";
import type { AppEnv } from "../../types";
import { apiClientsServiceFor } from "../api-clients";
import { currentToken } from "../auth/guards";
import { calendarServiceFor } from "../calendar";
import { contentServiceFor } from "../content";
import { serviceFor } from "../content/support";
import { reviewsServiceFor } from "../reviews";
import { type ApiCaller, type ApiPostsService, createApiPostsService } from "./posts";

export { mimeMatches, sniffMediaMime } from "./media";
export { type ApiCaller, type ApiPostsService, createApiPostsService, ownerActor } from "./posts";

/** Action of the audit row written for every write request of the machine API. */
export const API_REQUEST_AUDIT_ACTION = "api.request";

/** Whether `path` belongs to the machine API, which the session guard leaves alone. */
export function isApiV1Path(path: string): boolean {
  return path === API_V1_PREFIX || path.startsWith(`${API_V1_PREFIX}/`);
}

export function apiPostsServiceFor(deps: ModuleDeps): ApiPostsService {
  return serviceFor(deps, "apiPosts", () =>
    createApiPostsService({
      db: deps.db,
      clock: deps.clock,
      storage: deps.storage,
      assets: deps.assets,
      content: contentServiceFor(deps),
      reviews: reviewsServiceFor(deps),
      calendar: calendarServiceFor(deps),
      config: deps.config,
    }),
  );
}

/** The query string, parsed with `schema`; 400 `validation_failed` otherwise. */
function readQuery<S extends z.ZodType>(c: Context<AppEnv>, schema: S): z.output<S> {
  const parsed = schema.safeParse(c.req.query());
  if (!parsed.success) {
    throw validationFailed(issueDetails(parsed.error));
  }
  return parsed.data;
}

/** A body that may be left out: an empty body counts as `{}`. */
async function readOptionalJson<S extends z.ZodType>(
  c: Context<AppEnv>,
  schema: S,
): Promise<z.output<S>> {
  const text = await c.req.text();
  if (text.trim() === "") {
    const parsed = schema.safeParse({});
    if (!parsed.success) throw validationFailed(issueDetails(parsed.error));
    return parsed.data;
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw badRequest("The request body must be valid JSON.");
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw validationFailed(issueDetails(parsed.error));
  return parsed.data;
}

async function loadCaller(db: Database, c: Context<AppEnv>, trustProxy: boolean) {
  const token = currentToken(c);
  // The client acts for its owner; once that account is no longer the owner it can do nothing.
  if (token.user.role !== "owner") {
    throw forbidden("The account that owns this API client is no longer the owner.");
  }
  const [row] = await db
    .select({
      prefix: apiTokens.prefix,
      workspaceId: apiTokens.workspaceId,
      createdAt: apiTokens.createdAt,
      expiresAt: apiTokens.expiresAt,
    })
    .from(apiTokens)
    .where(eq(apiTokens.id, token.id))
    .limit(1);
  if (row === undefined || row.workspaceId === null) {
    throw forbidden("This API client has no workspace.");
  }
  return { token, row, workspaceId: row.workspaceId, ip: clientIp(c, trustProxy) };
}

/**
 * The machine API under `/api/v1`, for the owner's other backends:
 *
 * - API keys only (`Authorization: Bearer lc_api_…`). Cookies are never read and there is no
 *   CSRF check: this is not a browser surface. Unknown paths answer 401 without a key.
 * - 120 requests a minute per client (`API_V1_RATE_LIMIT`), 429 with `Retry-After` beyond.
 * - JSON only, `Cache-Control: no-store` on every answer (they carry upload URLs).
 * - One `api.request` audit row per write, with the client's token as the actor.
 * - A client reaches only its workspace and the channels it was granted; see `posts.ts`.
 */
export function register(app: Hono<AppEnv>, deps: ModuleDeps): Hono<AppEnv> {
  const { db, config, auth } = deps;
  const clients = apiClientsServiceFor(deps);
  const posts = apiPostsServiceFor(deps);
  const limiter = createRateLimiter(API_V1_RATE_LIMIT, deps.clock);
  const router = new Hono<AppEnv>();

  const guard = auth.requireBearer("api");
  for (const path of [API_V1_PREFIX, `${API_V1_PREFIX}/*`]) {
    router.use(path, guard);
    router.use(path, async (c, next) => {
      const token = currentToken(c);
      const result = limiter.take(token.id);
      c.header("RateLimit-Limit", String(API_V1_RATE_LIMIT.capacity));
      c.header("RateLimit-Remaining", String(result.remaining));
      if (!result.allowed) {
        throw rateLimited(result.retryAfterMs);
      }
      const contentType = c.req.header("content-type")?.split(";")[0]?.trim().toLowerCase();
      if (contentType !== undefined && contentType !== "application/json") {
        throw new HttpError(
          415,
          "unsupported_media_type",
          "Send request bodies as application/json.",
        );
      }
      await next();
      c.header("Cache-Control", "no-store");
    });
  }

  async function caller(c: Context<AppEnv>): Promise<ApiCaller> {
    const loaded = await loadCaller(db, c, config.trustProxy);
    return {
      tokenId: loaded.token.id,
      name: loaded.token.name,
      workspaceId: loaded.workspaceId,
      ownerId: loaded.token.user.id,
      grants: await clients.grants(loaded.token.id),
      ip: loaded.ip,
    };
  }

  /** The audit row of a write: the route, the post and what the route reports. */
  async function auditRequest(
    who: ApiCaller,
    route: keyof typeof routes,
    itemId: string | null,
    data: Record<string, unknown> = {},
  ): Promise<void> {
    await audit(db, {
      actorKind: "token",
      actorId: who.tokenId,
      action: API_REQUEST_AUDIT_ACTION,
      targetType: itemId === null ? null : "content_item",
      targetId: itemId,
      data: { route, ...data },
      ip: who.ip,
    });
  }

  router.get(routes["v1.me"].path, async (c) => {
    const loaded = await loadCaller(db, c, config.trustProxy);
    const [workspace] = await db
      .select({ id: workspaces.id, slug: workspaces.slug, name: workspaces.name })
      .from(workspaces)
      .where(eq(workspaces.id, loaded.workspaceId))
      .limit(1);
    if (workspace === undefined) {
      throw forbidden("This API client has no workspace.");
    }
    const grants = await clients.grants(loaded.token.id);
    const body: ApiV1Me = {
      client: {
        id: loaded.token.id,
        name: loaded.token.name,
        prefix: loaded.row.prefix,
        createdAt: loaded.row.createdAt.toISOString(),
        expiresAt: loaded.row.expiresAt?.toISOString() ?? null,
      },
      workspace,
      project: workspace,
      grants: [...grants].map(([channelId, access]) => ({ channelId, access })),
      rateLimit: {
        requests: API_V1_RATE_LIMIT.capacity,
        perSeconds: API_V1_RATE_LIMIT.intervalMs / 1000,
      },
    };
    return c.json(body, 200);
  });

  router.get(routes["v1.channels"].path, async (c) => {
    const who = await caller(c);
    const ids = [...who.grants.keys()];
    const rows =
      ids.length === 0
        ? []
        : await db
            .select({
              id: channels.id,
              platform: channels.platform,
              name: channels.displayName,
              username: channels.username,
              status: channels.status,
              dryRun: channels.dryRun,
              requiresApproval: channels.requiresApproval,
            })
            .from(channels)
            .where(inArray(channels.id, ids))
            .orderBy(asc(channels.platform), asc(channels.displayName), asc(channels.id));
    const items: ApiV1Channel[] = rows.map((row) => ({
      ...row,
      dryRun: row.dryRun || config.publishing.mode === "dry-run",
      access: who.grants.get(row.id) ?? "read",
      formats: [...PLATFORM_FORMATS[row.platform]],
    }));
    return c.json({ items }, 200);
  });

  router.get(routes["v1.formats"].path, (c) => c.json(postFormatCatalog(), 200));

  router.post(routes["v1.posts.create"].path, async (c) => {
    const who = await caller(c);
    const header = c.req.header("idempotency-key");
    let idempotencyKey: string | undefined;
    if (header !== undefined) {
      const parsed = IdempotencyKeySchema.safeParse(header);
      if (!parsed.success) {
        throw validationFailed([
          { path: "Idempotency-Key", message: "Use 1 to 200 visible ASCII characters" },
        ]);
      }
      idempotencyKey = parsed.data;
    }
    const input = await readJson(c, CreateApiPostRequestSchema);
    const created = await posts.create(who, input, {
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    });
    await auditRequest(who, "v1.posts.create", created.post.id, {
      format: input.format,
      channelIds: input.channels.map((target) => target.channelId),
      status: created.post.status,
      replayed: created.replayed,
    });
    if (created.replayed) {
      c.header("Idempotent-Replayed", "true");
    }
    return c.json(created.post, 201);
  });

  router.get(routes["v1.posts.list"].path, async (c) => {
    const who = await caller(c);
    return c.json(await posts.list(who, readQuery(c, ListApiPostsQuerySchema)), 200);
  });

  router.get(routes["v1.posts.get"].path, async (c) => {
    const who = await caller(c);
    return c.json(await posts.get(who, idParam(c)), 200);
  });

  router.get(routes["v1.posts.metrics"].path, async (c) => {
    const who = await caller(c);
    return c.json(await posts.metrics(who, idParam(c)), 200);
  });

  router.post(routes["v1.posts.uploads"].path, async (c) => {
    const who = await caller(c);
    const id = idParam(c);
    const post = await posts.uploads(who, id);
    await auditRequest(who, "v1.posts.uploads", id, { uploads: post.uploads.length });
    return c.json(post, 200);
  });

  router.post(routes["v1.posts.finalize"].path, async (c) => {
    const who = await caller(c);
    const id = idParam(c);
    await readOptionalJson(c, FinalizeApiPostRequestSchema);
    const post = await posts.finalize(who, id);
    await auditRequest(who, "v1.posts.finalize", id, {
      status: post.status,
      postIds: post.targets.flatMap((target) => (target.postId === null ? [] : [target.postId])),
    });
    return c.json(post, 200);
  });

  router.patch(routes["v1.posts.reschedule"].path, async (c) => {
    const who = await caller(c);
    const id = idParam(c);
    const input = await readJson(c, RescheduleApiPostRequestSchema);
    const post = await posts.reschedule(who, id, input);
    await auditRequest(who, "v1.posts.reschedule", id, { scheduledAt: input.scheduledAt });
    return c.json(post, 200);
  });

  router.post(routes["v1.posts.cancel"].path, async (c) => {
    const who = await caller(c);
    const id = idParam(c);
    const post = await posts.cancel(who, id);
    await auditRequest(who, "v1.posts.cancel", id, { status: post.status });
    return c.json(post, 200);
  });

  app.route("/", router);
  return router;
}
