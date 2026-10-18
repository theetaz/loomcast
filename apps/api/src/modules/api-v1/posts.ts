import { createHash } from "node:crypto";
import {
  API_IDEMPOTENCY_TTL_MS,
  type ApiChannelAccess,
  type ApiPost,
  type ApiPostMedia,
  type ApiPostMetrics,
  type ApiPostTarget,
  type ApiPostWithUploads,
  type ApiUpload,
  accessIncludes,
  CONTENT_TITLE_MAX_LENGTH,
  type CreateApiPostRequest,
  type CursorPage,
  DEFAULT_PAGE_LIMIT,
  formatMediaIssues,
  type ListApiPostsQuery,
  MIN_SCHEDULE_LEAD_MS,
  mediaTypeOfMime,
  POST_FORMAT_LABELS,
  type PostMediaEntry,
  type PublishingMode,
  RESCHEDULABLE_POST_STATUSES,
  type RescheduleApiPostRequest,
  type ScheduledPost,
} from "@loomcast/contracts";
import {
  type ApiPostRow,
  type AssetRow,
  apiIdempotencyKeys,
  apiPosts,
  assets,
  channels,
  contentItems,
  contentVersions,
  type Database,
  latestPostMetrics,
  scheduledPosts,
} from "@loomcast/db";
import { and, asc, desc, eq, inArray, lt, or, type SQL } from "drizzle-orm";
import type { Clock } from "../../lib/clock";
import { type Executor, type Transaction, transaction } from "../../lib/db";
import { conflict, forbidden, HttpError, notFound, validationFailed } from "../../lib/errors";
import type { Storage } from "../../lib/storage";
import { toPostMetrics } from "../analytics/mappers";
import type { AssetActor, AssetsService } from "../assets/service";
import { storageUnavailable } from "../assets/service";
import { refusedChannels, scheduleComposed, throwRefusals } from "../calendar/compose";
import { byScheduledAt, loadScheduledPosts, newPostDryRun } from "../calendar/posts";
import type { CalendarService } from "../calendar/service";
import type { ContentService, PipelineActor } from "../content";
import { lockItem } from "../content/queries";
import { decodeCursor, encodeCursor } from "../content/support";
import type { ReviewsService } from "../reviews/service";
import { mimeMatches, readHead, sniffMediaMime } from "./media";
import { selectVisiblePosts, type VisiblePost } from "./queries";

// Posts of the machine API. A post is a content item of the client's project, created as an idea
// with the files the client declared; once the files are uploaded, `finalize` writes the version,
// submits it and creates one post per channel in a single transaction. With `publish` on every
// channel (and no channel that requires approval) the version is approved on the owner's behalf
// and the posts are queued; otherwise they wait, planned, in the owner's approvals.
//
// The services need a user to submit, approve and schedule, so the client acts as its owner (the
// transition table keeps approval and scheduling closed to tokens). The audit row of each request
// names the client.

/** The API client behind a request, with its grants as loaded for this request. */
export interface ApiCaller {
  tokenId: string;
  name: string;
  /** The project its posts are created in. */
  projectId: string;
  /** The owner, whom the client acts for. */
  ownerId: string;
  grants: ReadonlyMap<string, ApiChannelAccess>;
  ip: string | null;
}

export interface ApiPostsDeps {
  db: Database;
  clock: Clock;
  storage: Storage;
  assets: AssetsService;
  content: ContentService;
  reviews: Pick<ReviewsService, "create">;
  calendar: CalendarService;
  config: { publishing: { mode: PublishingMode } };
}

export interface CreateApiPostOptions {
  idempotencyKey?: string;
}

export interface CreatedApiPost {
  post: ApiPostWithUploads;
  /** True when an earlier request with the same `Idempotency-Key` created the post. */
  replayed: boolean;
}

export interface ApiPostsService {
  create(
    caller: ApiCaller,
    input: CreateApiPostRequest,
    options?: CreateApiPostOptions,
  ): Promise<CreatedApiPost>;
  get(caller: ApiCaller, itemId: string): Promise<ApiPost>;
  list(caller: ApiCaller, query: ListApiPostsQuery): Promise<CursorPage<ApiPost>>;
  uploads(caller: ApiCaller, itemId: string): Promise<ApiPostWithUploads>;
  finalize(caller: ApiCaller, itemId: string): Promise<ApiPost>;
  reschedule(caller: ApiCaller, itemId: string, input: RescheduleApiPostRequest): Promise<ApiPost>;
  cancel(caller: ApiCaller, itemId: string): Promise<ApiPost>;
  metrics(caller: ApiCaller, itemId: string): Promise<ApiPostMetrics>;
}

/** A channel the client was not granted reads exactly like one that does not exist. */
export const NOT_GRANTED = "No channel with that id is granted to this API client";

const postNotFound = () => notFound("No post has that id.");

/** The owner, as the actor of the pipeline moves an API client makes. */
export function ownerActor(caller: ApiCaller): PipelineActor {
  return { kind: "user", id: caller.ownerId, userId: caller.ownerId, ip: caller.ip };
}

/** The client itself, as the actor of its uploads. */
function assetActor(caller: ApiCaller): AssetActor {
  return { kind: "token", id: caller.tokenId, userId: caller.ownerId, ip: caller.ip };
}

/**
 * Checks the client's level on each channel: 400 `validation_failed` for channels it was not
 * granted (named like unknown ones, so nothing leaks), then 403 `forbidden` for channels it may
 * not act on at `level`.
 */
export function requireAccess(
  caller: ApiCaller,
  entries: readonly { channelId: string; path: string }[],
  level: ApiChannelAccess,
): void {
  const missing = entries.filter((entry) => !caller.grants.has(entry.channelId));
  if (missing.length > 0) {
    throw validationFailed(missing.map(({ path }) => ({ path, message: NOT_GRANTED })));
  }
  const short = entries.filter((entry) => {
    const granted = caller.grants.get(entry.channelId);
    return granted === undefined || !accessIncludes(granted, level);
  });
  if (short.length > 0) {
    throw new HttpError(
      403,
      "forbidden",
      `This API client needs ${level} access on every channel of the post.`,
      short.map(({ channelId, path }) => ({
        path,
        channelId,
        access: caller.grants.get(channelId) ?? null,
        required: level,
      })),
    );
  }
}

/** JSON with object keys sorted, so the same request always hashes the same. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function requestHash(input: CreateApiPostRequest): string {
  return createHash("sha256").update(canonicalJson(input), "utf8").digest("hex");
}

/** Thrown inside the create transaction to roll it back and answer with an earlier post. */
class IdempotentReplay {
  constructor(readonly itemId: string) {}
}

function idempotencyConflict(): HttpError {
  return new HttpError(
    409,
    "idempotency_conflict",
    "This Idempotency-Key was used with a different request body.",
  );
}

function uploadMissing(index: number, mediaId: string | null, reason: string): HttpError {
  const message =
    reason === "failed_verification"
      ? `File ${index} failed verification (size or SHA-256). Call POST /api/v1/posts/:id/uploads and upload it again.`
      : `File ${index} has not been uploaded yet. PUT it to its upload URL first.`;
  return new HttpError(409, "upload_missing", message, { index, mediaId, reason });
}

/** The caption's first line as a title, or the format and the client's name. */
function defaultTitle(input: CreateApiPostRequest, clientName: string): string {
  const line = input.caption
    ?.split("\n")
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  const title = line ?? `${POST_FORMAT_LABELS[input.format]} from ${clientName}`;
  return title.length > CONTENT_TITLE_MAX_LENGTH
    ? `${title.slice(0, CONTENT_TITLE_MAX_LENGTH - 1)}…`
    : title;
}

/** The live `media` asset of the item with this checksum, else a failed one, else null. */
function mediaAsset(rows: readonly AssetRow[], sha256: string): AssetRow | null {
  const matching = rows.filter((row) => row.sha256 === sha256);
  return matching.find((row) => row.status !== "failed") ?? matching[0] ?? null;
}

async function itemMediaAssets(executor: Executor, itemIds: readonly string[]) {
  if (itemIds.length === 0) return [];
  return executor
    .select()
    .from(assets)
    .where(and(inArray(assets.itemId, [...itemIds]), eq(assets.kind, "media")))
    .orderBy(desc(assets.createdAt));
}

export function createApiPostsService(deps: ApiPostsDeps): ApiPostsService {
  const { db, clock, storage, content, reviews, calendar } = deps;

  function viewer(caller: ApiCaller) {
    return { tokenId: caller.tokenId, channelIds: [...caller.grants.keys()] };
  }

  /** The resources of `visible`, in the same order. */
  async function loadPosts(
    executor: Executor,
    caller: ApiCaller,
    visible: readonly VisiblePost[],
  ): Promise<ApiPost[]> {
    if (visible.length === 0) return [];
    const ids = visible.map((post) => post.itemId);
    const ownIds = visible.filter((post) => post.own).map((post) => post.itemId);
    const items = await executor
      .select({
        id: contentItems.id,
        title: contentItems.title,
        createdAt: contentItems.createdAt,
        updatedAt: contentItems.updatedAt,
        format: contentVersions.format,
        caption: contentVersions.caption,
        media: contentVersions.media,
      })
      .from(contentItems)
      .innerJoin(contentVersions, eq(contentVersions.id, contentItems.currentVersionId))
      .where(inArray(contentItems.id, ids));
    const requested =
      ownIds.length === 0
        ? []
        : await executor
            .select()
            .from(apiPosts)
            .where(and(inArray(apiPosts.itemId, ownIds), eq(apiPosts.tokenId, caller.tokenId)));
    const granted = [...caller.grants.keys()];
    const visibleTargets: SQL[] = [];
    if (ownIds.length > 0) visibleTargets.push(inArray(scheduledPosts.itemId, ownIds));
    if (granted.length > 0) visibleTargets.push(inArray(scheduledPosts.channelId, granted));
    const targetIds =
      visibleTargets.length === 0
        ? []
        : await executor
            .select({ id: scheduledPosts.id })
            .from(scheduledPosts)
            .where(and(inArray(scheduledPosts.itemId, ids), or(...visibleTargets)));
    const targets = (
      await loadScheduledPosts(
        executor,
        targetIds.map((row) => row.id),
      )
    ).sort(byScheduledAt);
    const mediaRows = await itemMediaAssets(executor, ids);
    const declaredChannels = [
      ...new Set(requested.flatMap((row) => row.targets.map((target) => target.channelId))),
    ];
    const channelRows =
      declaredChannels.length === 0
        ? []
        : await executor
            .select({ id: channels.id, platform: channels.platform, dryRun: channels.dryRun })
            .from(channels)
            .where(inArray(channels.id, declaredChannels));

    const itemById = new Map(items.map((item) => [item.id, item]));
    const requestById = new Map(requested.map((row) => [row.itemId, row]));
    const channelById = new Map(channelRows.map((row) => [row.id, row]));
    const assetById = new Map(mediaRows.map((row) => [row.id, row]));

    const result: ApiPost[] = [];
    for (const view of visible) {
      const item = itemById.get(view.itemId);
      if (item === undefined) continue;
      const request = view.own ? requestById.get(view.itemId) : undefined;
      const awaiting = request !== undefined && request.finalizedAt === null;
      const itemAssets = mediaRows.filter((row) => row.itemId === item.id);
      let media: ApiPostMedia[];
      let postTargets: ApiPostTarget[];
      if (awaiting) {
        media = request.media.map((entry) => {
          const asset = mediaAsset(itemAssets, entry.sha256);
          return {
            mediaId: asset?.id ?? null,
            type: mediaTypeOfMime(entry.mime) ?? "image",
            altText: entry.altText ?? null,
            status: asset?.status ?? "pending",
          };
        });
        postTargets = request.targets.flatMap((target) => {
          const channel = channelById.get(target.channelId);
          if (channel === undefined) return [];
          return [
            {
              channelId: target.channelId,
              platform: channel.platform,
              postId: null,
              status: null,
              scheduledAt: request.scheduledAt.toISOString(),
              permalink: null,
              externalId: null,
              lastError: null,
              publishedAt: null,
              dryRun: newPostDryRun(channel, deps.config.publishing.mode),
            },
          ];
        });
      } else {
        media = item.media.map((entry) => ({
          mediaId: entry.assetId,
          type: entry.type,
          altText: entry.altText ?? null,
          status: assetById.get(entry.assetId)?.status ?? "ready",
        }));
        postTargets = targets
          .filter((post) => post.itemId === item.id)
          .map((post: ScheduledPost) => ({
            channelId: post.channelId,
            platform: post.platform,
            postId: post.id,
            status: post.status,
            scheduledAt: post.scheduledAt,
            permalink: post.permalink,
            externalId: post.externalId,
            lastError: post.lastError,
            publishedAt: post.publishedAt,
            dryRun: post.dryRun,
          }));
      }
      const touched = [
        item.updatedAt.toISOString(),
        ...targets.filter((post) => post.itemId === item.id).map((post) => post.updatedAt),
        ...(request?.cancelledAt ? [request.cancelledAt.toISOString()] : []),
      ].sort();
      result.push({
        id: item.id,
        externalRef: request?.externalRef ?? null,
        own: view.own,
        format: awaiting ? request.format : item.format,
        title: item.title,
        caption: awaiting ? request.caption : item.caption,
        status: view.status,
        scheduledAt: view.scheduledAt?.toISOString() ?? null,
        media,
        targets: postTargets,
        createdAt: item.createdAt.toISOString(),
        updatedAt: touched.at(-1) ?? item.updatedAt.toISOString(),
      });
    }
    return result;
  }

  async function getPost(executor: Executor, caller: ApiCaller, itemId: string) {
    const [visible] = await selectVisiblePosts(executor, viewer(caller), { itemIds: [itemId] });
    if (visible === undefined) throw postNotFound();
    const [post] = await loadPosts(executor, caller, [visible]);
    if (post === undefined) throw postNotFound();
    return post;
  }

  /** The client's own post request: 403 for a post it only sees, 404 for one it cannot see. */
  async function requireOwn(
    executor: Executor,
    caller: ApiCaller,
    itemId: string,
    lock = false,
  ): Promise<ApiPostRow> {
    const query = executor
      .select()
      .from(apiPosts)
      .where(and(eq(apiPosts.itemId, itemId), eq(apiPosts.tokenId, caller.tokenId)))
      .limit(1);
    const [row] = lock ? await query.for("update") : await query;
    if (row !== undefined) return row;
    const visible = await selectVisiblePosts(executor, viewer(caller), { itemIds: [itemId] });
    if (visible.length > 0) {
      throw forbidden("Only the API client that created a post can change it.");
    }
    throw postNotFound();
  }

  function requireLead(at: string): void {
    if (Date.parse(at) < clock.now().getTime() + MIN_SCHEDULE_LEAD_MS) {
      throw validationFailed([
        { path: "scheduledAt", message: "Pick a time at least two minutes ahead" },
      ]);
    }
  }

  /** Upload instructions for every declared file that is not ready yet, in media order. */
  async function startUploads(caller: ApiCaller, row: ApiPostRow): Promise<ApiUpload[]> {
    if (row.media.length === 0) return [];
    if (!storage.configured) throw storageUnavailable();
    const uploads: ApiUpload[] = [];
    for (const entry of row.media) {
      const started = await deps.assets.createUpload(
        {
          projectId: caller.projectId,
          itemId: row.itemId,
          kind: "media",
          filename: entry.filename,
          mime: entry.mime as Parameters<AssetsService["createUpload"]>[0]["mime"],
          bytes: entry.bytes,
          sha256: entry.sha256,
        },
        assetActor(caller),
      );
      if (started.upload !== null) {
        uploads.push({ mediaId: started.asset.id, ...started.upload, method: "PUT" });
      }
    }
    return uploads;
  }

  /**
   * Writes the version with `media`, checks every channel, then submits the post and creates its
   * posts: approved and queued with `publish` on every channel and no channel that requires
   * approval, planned for the owner's approval otherwise. Marks the request finalized.
   */
  async function scheduleRequest(
    tx: Transaction,
    caller: ApiCaller,
    row: ApiPostRow,
    media: PostMediaEntry[],
  ): Promise<void> {
    const actor = ownerActor(caller);
    const written = await content.createVersion(
      tx,
      row.itemId,
      { format: row.format, media, caption: row.caption },
      actor,
      { createdVia: "api" },
    );
    const channelIds = row.targets.map((target) => target.channelId);
    throwRefusals(
      await refusedChannels(
        tx,
        row.itemId,
        written.version,
        channelIds,
        (index) => `channels.${index}.channelId`,
      ),
    );
    const gated = await tx
      .select({ id: channels.id })
      .from(channels)
      .where(and(inArray(channels.id, channelIds), eq(channels.requiresApproval, true)));
    const publish =
      gated.length === 0 &&
      channelIds.every((channelId) => caller.grants.get(channelId) === "publish");
    const item = await lockItem(tx, row.itemId);
    if (item === null) throw postNotFound();
    await scheduleComposed(
      tx,
      { content, reviews, calendar },
      {
        item,
        version: written.version,
        targets: row.targets,
        scheduledAt: row.scheduledAt.toISOString(),
        approve: publish
          ? { comment: `Approved on the owner's behalf by the API client "${caller.name}".` }
          : null,
      },
      actor,
    );
    await tx
      .update(apiPosts)
      .set({ finalizedAt: clock.now() })
      .where(eq(apiPosts.itemId, row.itemId));
  }

  async function withUploads(
    caller: ApiCaller,
    itemId: string,
    uploads: ApiUpload[],
  ): Promise<ApiPostWithUploads> {
    return { ...(await getPost(db, caller, itemId)), uploads };
  }

  return {
    async create(caller, input, options = {}) {
      requireAccess(
        caller,
        input.channels.map((target, index) => ({
          channelId: target.channelId,
          path: `channels.${index}.channelId`,
        })),
        "write",
      );
      const media = input.media ?? [];
      const issues = formatMediaIssues({
        format: input.format,
        media: media.map((entry) => ({ type: mediaTypeOfMime(entry.mime) ?? "image" })),
      });
      if (issues.length > 0) {
        throw validationFailed(issues.map((message) => ({ path: "media", message })));
      }
      if (input.format === "text" && (input.caption ?? "") === "") {
        throw validationFailed([{ path: "caption", message: "A text post needs a caption" }]);
      }
      const declaredTypes = media.map((entry) => ({
        type: mediaTypeOfMime(entry.mime) ?? "image",
      }));
      throwRefusals(
        await refusedChannels(
          db,
          null,
          { format: input.format, media: declaredTypes },
          input.channels.map((target) => target.channelId),
          (index) => `channels.${index}.channelId`,
        ),
      );
      requireLead(input.scheduledAt);
      if (media.length > 0 && !storage.configured) {
        throw storageUnavailable();
      }

      const key = options.idempotencyKey;
      const hash = key === undefined ? null : requestHash(input);
      const now = clock.now();

      /** An earlier request with this key: the same post, or 409 for another body. */
      async function earlier(tx: Transaction): Promise<void> {
        if (key === undefined) return;
        const [found] = await tx
          .select()
          .from(apiIdempotencyKeys)
          .where(
            and(eq(apiIdempotencyKeys.tokenId, caller.tokenId), eq(apiIdempotencyKeys.key, key)),
          )
          .limit(1);
        if (found === undefined) return;
        if (found.requestHash !== hash) throw idempotencyConflict();
        throw new IdempotentReplay(found.itemId);
      }

      let itemId: string;
      try {
        itemId = await transaction(db, async (tx) => {
          if (key !== undefined) {
            await tx
              .delete(apiIdempotencyKeys)
              .where(
                and(
                  eq(apiIdempotencyKeys.tokenId, caller.tokenId),
                  lt(
                    apiIdempotencyKeys.createdAt,
                    new Date(now.getTime() - API_IDEMPOTENCY_TTL_MS),
                  ),
                ),
              );
            await earlier(tx);
          }
          const actor = ownerActor(caller);
          const created = await content.create(
            caller.projectId,
            {
              title: input.title ?? defaultTitle(input, caller.name),
              format: input.format,
              targetAt: input.scheduledAt,
            },
            actor,
            { tx, createdVia: "api" },
          );
          const [row] = await tx
            .insert(apiPosts)
            .values({
              itemId: created.item.id,
              tokenId: caller.tokenId,
              externalRef: input.externalRef ?? null,
              format: input.format,
              caption: input.caption ?? null,
              media: media.map((entry) => ({
                filename: entry.filename,
                mime: entry.mime,
                bytes: entry.bytes,
                sha256: entry.sha256,
                ...(entry.altText === undefined || entry.altText === ""
                  ? {}
                  : { altText: entry.altText }),
              })),
              targets: input.channels.map((target) => ({
                channelId: target.channelId,
                ...(target.options === undefined ? {} : { options: target.options }),
              })),
              scheduledAt: new Date(input.scheduledAt),
              createdAt: now,
            })
            .returning();
          if (row === undefined) throw new Error("API post was not inserted");
          if (key !== undefined && hash !== null) {
            const stored = await tx
              .insert(apiIdempotencyKeys)
              .values({
                tokenId: caller.tokenId,
                key,
                requestHash: hash,
                itemId: row.itemId,
                createdAt: now,
              })
              .onConflictDoNothing()
              .returning({ key: apiIdempotencyKeys.key });
            // A concurrent request with the same key committed first.
            if (stored.length === 0) await earlier(tx);
          }
          // A text post has nothing to upload: it is scheduled in the same transaction.
          if (media.length === 0) {
            await scheduleRequest(tx, caller, row, []);
          }
          return row.itemId;
        });
      } catch (error) {
        if (error instanceof IdempotentReplay) {
          const row = await requireOwn(db, caller, error.itemId);
          const uploads =
            row.finalizedAt === null && row.cancelledAt === null
              ? await startUploads(caller, row)
              : [];
          return { post: await withUploads(caller, error.itemId, uploads), replayed: true };
        }
        throw error;
      }
      const row = await requireOwn(db, caller, itemId);
      const uploads = await startUploads(caller, row);
      return { post: await withUploads(caller, itemId, uploads), replayed: false };
    },

    get: (caller, itemId) => getPost(db, caller, itemId),

    async list(caller, query) {
      if (query.channelId !== undefined && !caller.grants.has(query.channelId)) {
        throw validationFailed([{ path: "channelId", message: NOT_GRANTED }]);
      }
      const limit = query.limit ?? DEFAULT_PAGE_LIMIT;
      const cursor =
        query.cursor === undefined ? undefined : decodeCursor(query.cursor, ["createdAt", "id"]);
      const rows = await selectVisiblePosts(db, viewer(caller), {
        ...(query.channelId === undefined ? {} : { channelId: query.channelId }),
        ...(query.status === undefined ? {} : { status: query.status }),
        ...(query.from === undefined ? {} : { from: new Date(query.from) }),
        ...(query.to === undefined ? {} : { to: new Date(query.to) }),
        ...(cursor === undefined
          ? {}
          : { before: { createdAt: cursor.createdAt ?? "", id: cursor.id ?? "" } }),
        limit: limit + 1,
      });
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        items: await loadPosts(db, caller, page),
        nextCursor:
          rows.length > limit && last !== undefined
            ? encodeCursor({ createdAt: last.createdAt, id: last.itemId })
            : null,
      };
    },

    async uploads(caller, itemId) {
      const row = await requireOwn(db, caller, itemId);
      if (row.cancelledAt !== null) {
        throw conflict("This post is cancelled.", { reason: "cancelled" });
      }
      const uploads = row.finalizedAt === null ? await startUploads(caller, row) : [];
      return withUploads(caller, itemId, uploads);
    },

    async finalize(caller, itemId) {
      const row = await requireOwn(db, caller, itemId);
      if (row.cancelledAt !== null) {
        throw conflict("This post is cancelled.", { reason: "cancelled" });
      }
      if (row.finalizedAt !== null) {
        return getPost(db, caller, itemId);
      }
      requireAccess(
        caller,
        row.targets.map((target, index) => ({
          channelId: target.channelId,
          path: `channels.${index}.channelId`,
        })),
        "write",
      );
      if (row.media.length > 0 && !storage.configured) {
        throw storageUnavailable();
      }

      const itemAssets = await itemMediaAssets(db, [itemId]);
      const entries: PostMediaEntry[] = [];
      for (const [index, declared] of row.media.entries()) {
        const asset = mediaAsset(itemAssets, declared.sha256);
        if (asset === null) throw uploadMissing(index, null, "not_uploaded");
        if (asset.status === "failed") throw uploadMissing(index, asset.id, "failed_verification");
        if (asset.status === "pending") {
          if ((await storage.head(asset.storageKey)) === null) {
            throw uploadMissing(index, asset.id, "not_uploaded");
          }
          // The bytes must be what the client said they are before anything publishes them.
          const sniffed = sniffMediaMime(await readHead(storage, asset.storageKey));
          if (!mimeMatches(asset.mime, sniffed)) {
            throw new HttpError(
              422,
              "media_type_mismatch",
              `File ${index} is not a ${asset.mime} file. Cancel this post and create it again with the right type.`,
              { index, mediaId: asset.id, declared: asset.mime, detected: sniffed },
            );
          }
          const finalized = await deps.assets.finalize(asset.id, {}, assetActor(caller));
          if (finalized === null || finalized.status !== "ready") {
            throw uploadMissing(index, asset.id, "failed_verification");
          }
        }
        const type = mediaTypeOfMime(asset.mime);
        if (type === null) throw new Error("a media asset with a MIME type posts cannot carry");
        entries.push({
          assetId: asset.id,
          type,
          ...(declared.altText === undefined ? {} : { altText: declared.altText }),
        });
      }

      await transaction(db, async (tx) => {
        // The item first, as every writer of an item and its posts locks it.
        await lockItem(tx, itemId);
        const locked = await requireOwn(tx, caller, itemId, true);
        if (locked.finalizedAt !== null || locked.cancelledAt !== null) return;
        await scheduleRequest(tx, caller, locked, entries);
      });
      return getPost(db, caller, itemId);
    },

    async reschedule(caller, itemId, input) {
      const actor = ownerActor(caller);
      await transaction(db, async (tx) => {
        await lockItem(tx, itemId);
        const row = await requireOwn(tx, caller, itemId, true);
        if (row.cancelledAt !== null) {
          throw conflict("This post is cancelled.", { reason: "cancelled" });
        }
        requireLead(input.scheduledAt);
        if (row.finalizedAt !== null) {
          const open = await tx
            .select({
              id: scheduledPosts.id,
              channelId: scheduledPosts.channelId,
              updatedAt: scheduledPosts.updatedAt,
            })
            .from(scheduledPosts)
            .where(
              and(
                eq(scheduledPosts.itemId, itemId),
                inArray(scheduledPosts.status, [...RESCHEDULABLE_POST_STATUSES]),
              ),
            )
            .orderBy(asc(scheduledPosts.scheduledAt), asc(scheduledPosts.id));
          if (open.length === 0) {
            throw new HttpError(
              409,
              "post_not_editable",
              "This post has nothing left to move: it is publishing, published or cancelled.",
            );
          }
          requireAccess(
            caller,
            open.map((post) => ({ channelId: post.channelId, path: `targets.${post.id}` })),
            "write",
          );
          for (const post of open) {
            await calendar.reschedule(
              post.id,
              { scheduledAt: input.scheduledAt, expectedUpdatedAt: post.updatedAt.toISOString() },
              actor,
              { tx },
            );
          }
        }
        await tx
          .update(apiPosts)
          .set({ scheduledAt: new Date(input.scheduledAt) })
          .where(eq(apiPosts.itemId, itemId));
      });
      return getPost(db, caller, itemId);
    },

    async cancel(caller, itemId) {
      const actor = ownerActor(caller);
      await transaction(db, async (tx) => {
        await lockItem(tx, itemId);
        const row = await requireOwn(tx, caller, itemId, true);
        if (row.cancelledAt !== null) return;
        if (row.finalizedAt === null) {
          await tx
            .update(apiPosts)
            .set({ cancelledAt: clock.now() })
            .where(eq(apiPosts.itemId, itemId));
          await content.archive(itemId, actor, { tx });
          return;
        }
        const posts = await tx
          .select({
            id: scheduledPosts.id,
            channelId: scheduledPosts.channelId,
            status: scheduledPosts.status,
          })
          .from(scheduledPosts)
          .where(eq(scheduledPosts.itemId, itemId));
        const open = posts.filter((post) =>
          (RESCHEDULABLE_POST_STATUSES as readonly string[]).includes(post.status),
        );
        if (open.length === 0) {
          throw new HttpError(
            409,
            "post_not_editable",
            "This post has nothing left to cancel: it is publishing, published or cancelled.",
          );
        }
        requireAccess(
          caller,
          open.map((post) => ({ channelId: post.channelId, path: `targets.${post.id}` })),
          "write",
        );
        for (const post of open) {
          await calendar.cancel(post.id, actor, { tx });
        }
        // Withdrawn everywhere: the item leaves the owner's approvals and calendar too.
        if (!posts.some((post) => post.status === "publishing" || post.status === "published")) {
          await tx
            .update(apiPosts)
            .set({ cancelledAt: clock.now() })
            .where(eq(apiPosts.itemId, itemId));
          await content.archive(itemId, actor, { tx });
        }
      });
      return getPost(db, caller, itemId);
    },

    async metrics(caller, itemId) {
      const post = await getPost(db, caller, itemId);
      const published = post.targets.filter(
        (target): target is ApiPostTarget & { postId: string } =>
          target.postId !== null && target.status === "published",
      );
      const latest = await latestPostMetrics(
        db,
        published.map((target) => target.postId),
      );
      const byPost = new Map(latest.map((row) => [row.postId, toPostMetrics(row)]));
      return {
        id: post.id,
        targets: published.map((target) => ({
          channelId: target.channelId,
          platform: target.platform,
          postId: target.postId,
          metrics: byPost.get(target.postId) ?? null,
        })),
      };
    },
  };
}
