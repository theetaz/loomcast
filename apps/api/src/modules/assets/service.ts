import { createHash } from "node:crypto";
import type { Readable } from "node:stream";
import type {
  Asset,
  AssetDetail,
  AssetKind,
  AssetMimeType,
  AssetUrl,
  AssetUrlQuery,
  FinalizeAssetRequest,
  ListItemAssetsQuery,
  UploadInstructions,
} from "@loomcast/contracts";
import { type AssetMeta, type AssetRow, assets, contentItems, type Database } from "@loomcast/db";
import { and, desc, eq, isNull, lt, ne, sql } from "drizzle-orm";
import { audit } from "../../lib/audit";
import type { EventBus } from "../../lib/bus";
import type { Clock } from "../../lib/clock";
import { afterCommit, type Executor, type Transaction, transaction } from "../../lib/db";
import { conflict, HttpError, validationFailed } from "../../lib/errors";
import type { Logger } from "../../lib/logger";
import { assetStorageKey, type Storage } from "../../lib/storage";
import { requireActiveWorkspace } from "../kb/service";
import { toAsset, toAssetDetail } from "./mappers";

/** Pending uploads older than this are deleted by `cleanupPendingUploads`. */
export const PENDING_UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;

/** Most pending uploads one cleanup pass deletes. */
const CLEANUP_BATCH = 500;

/**
 * Who asks for or finalizes an upload: a signed-in user, or a token acting for its user (an MCP
 * token, or the job token of a studio agent job, which also sets `jobId`).
 */
export interface AssetActor {
  kind: "user" | "token";
  /** The user id, or the token id for `token`. */
  id: string;
  /** The account the asset is created for. */
  userId: string;
  /** The job a job token was minted for; stored as the asset's `created_by_job`. */
  jobId?: string | null;
  ip?: string | null;
}

export interface CreateUploadInput {
  workspaceId: string;
  /**
   * Must be an item of `workspaceId`. The asset belongs to the item, and uploads are deduplicated
   * per item; without it the asset is workspace-level media, deduplicated per workspace.
   */
  itemId?: string;
  kind: AssetKind;
  filename: string;
  mime: AssetMimeType;
  bytes: number;
  /** Lowercase hex. */
  sha256: string;
}

export interface CreateUploadResult {
  asset: Asset;
  /** Null when the asset's owner already has this file as a ready asset of the same kind. */
  upload: UploadInstructions | null;
  /** False when an existing asset was returned. */
  created: boolean;
}

/** Why `finalize` failed an upload. Logged and audited; clients see `status: "failed"`. */
export type VerificationFailure = "size_mismatch" | "checksum_mismatch" | "unverifiable";

export interface AssetsService {
  /**
   * Starts an upload: inserts a `pending` asset and presigns a PUT to its content-addressed key.
   * When the asset's owner already holds the same kind and SHA-256 (a live asset, not a failed
   * one), that asset is returned instead: `upload: null` when it is ready, a fresh upload URL when
   * it is still pending. The owner is the item when `itemId` is given, so another item's copy of
   * the same bytes is never returned and a version can always use the asset; without `itemId` it
   * is the workspace's workspace-level media (reference media). A failed asset with the same key is
   * reset to pending and reused. 404 for an unknown workspace, 409 for an archived one, 400 when
   * `itemId` is not an item of the workspace.
   */
  createUpload(input: CreateUploadInput, actor: AssetActor): Promise<CreateUploadResult>;
  /**
   * Verifies a pending upload: the stored size, then the SHA-256 the store checked on upload or,
   * when the store did not record one, a hash of the stored bytes (up to `assetVerifyMaxBytes`).
   * A match makes the asset `ready` and stores the probe (and a voice take's alignment); a
   * mismatch makes it `failed` and deletes the object. Finalizing a ready asset returns it as is.
   * 409 `upload_missing` while nothing is stored yet; 409 `failed` for a failed asset. Null when
   * there is no such asset.
   */
  finalize(id: string, input: FinalizeAssetRequest, actor: AssetActor): Promise<Asset | null>;
  /** The asset with its alignment, or null. */
  get(id: string): Promise<AssetDetail | null>;
  /** The raw row, for services that need the storage key (the publisher's `promoteToPublic`). */
  getRow(id: string, executor?: Executor): Promise<AssetRow | null>;
  /** A one-hour download URL for a ready asset. 409 `not_ready` otherwise; null for no asset. */
  url(id: string, query?: AssetUrlQuery): Promise<AssetUrl | null>;
  /** An item's assets, newest first. Null when there is no such item. */
  listForItem(itemId: string, query?: ListItemAssetsQuery): Promise<Asset[] | null>;
  /**
   * Deletes pending uploads (row and object) requested more than `olderThanMs` ago. Returns how
   * many were deleted.
   */
  cleanupPendingUploads(olderThanMs?: number): Promise<number>;
}

export interface AssetsServiceDeps {
  db: Database;
  bus: EventBus;
  clock: Clock;
  logger: Logger;
  storage: Storage;
  config: { assetVerifyMaxBytes: number };
}

type Verification =
  | { kind: "ok"; via: "store" | "hash" }
  | { kind: "failed"; reason: VerificationFailure }
  | { kind: "missing" };

/** 503 for operations that need object storage on a server started without it. */
export const storageUnavailable = () =>
  new HttpError(503, "storage_unavailable", "Object storage is not configured on this server.");

/**
 * `status <> 'failed'`, the shared part of the predicates of the dedupe indexes
 * `assets_workspace_id_item_id_kind_sha256_uq` (item assets) and `assets_workspace_id_kind_sha256_uq`
 * (workspace-level media).
 */
const LIVE = ne(assets.status, "failed");

/** SHA-256 of a stream as lowercase hex; null when it runs past `maxBytes`. */
export async function hashStream(stream: Readable, maxBytes: number): Promise<string | null> {
  const hash = createHash("sha256");
  let total = 0;
  for await (const chunk of stream) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > maxBytes) {
      stream.destroy();
      return null;
    }
    hash.update(buffer);
  }
  return hash.digest("hex");
}

export function createAssetsService(deps: AssetsServiceDeps): AssetsService {
  const { db, bus, storage, logger } = deps;
  const log = logger.child({ module: "assets" });

  function publish(executor: Executor, row: AssetRow): void {
    const asset = toAsset(row);
    afterCommit(executor, () => bus.publish({ type: "asset.updated", payload: { asset } }));
  }

  async function presign(row: AssetRow): Promise<UploadInstructions> {
    const upload = await storage.presignPut({
      key: row.storageKey,
      mime: row.mime,
      bytes: row.bytes,
      sha256: row.sha256,
    });
    return { ...upload, expiresAt: upload.expiresAt.toISOString() };
  }

  async function requireItemOfWorkspace(
    tx: Transaction,
    workspaceId: string,
    itemId: string,
  ): Promise<void> {
    const [item] = await tx
      .select({ id: contentItems.id })
      .from(contentItems)
      .where(and(eq(contentItems.id, itemId), eq(contentItems.workspaceId, workspaceId)))
      .limit(1);
    if (item === undefined) {
      throw validationFailed([
        { path: "itemId", message: "No content item with that id in this workspace" },
      ]);
    }
  }

  /**
   * The live asset an upload deduplicates against: same owner (the item, or the workspace's
   * workspace-level media when there is no item), kind and SHA-256. Locked until the transaction ends.
   */
  async function findLive(tx: Transaction, input: CreateUploadInput): Promise<AssetRow | null> {
    const [row] = await tx
      .select()
      .from(assets)
      .where(
        and(
          eq(assets.workspaceId, input.workspaceId),
          input.itemId === undefined ? isNull(assets.itemId) : eq(assets.itemId, input.itemId),
          eq(assets.kind, input.kind),
          eq(assets.sha256, input.sha256),
          LIVE,
        ),
      )
      .limit(1)
      .for("update");
    return row ?? null;
  }

  /**
   * An existing live asset: a ready one needs no upload. A pending one gets a fresh URL, and its
   * `createdAt` moves to now so the pending-upload cleanup does not delete it mid-upload.
   */
  async function existing(tx: Transaction, row: AssetRow): Promise<AssetRow> {
    if (row.status !== "pending") {
      return row;
    }
    const [touched] = await tx
      .update(assets)
      .set({ createdAt: sql`now()` })
      .where(eq(assets.id, row.id))
      .returning();
    return touched ?? row;
  }

  async function verify(row: AssetRow): Promise<Verification> {
    const stored = await storage.head(row.storageKey);
    if (stored === null) {
      return { kind: "missing" };
    }
    if (stored.bytes !== row.bytes) {
      return { kind: "failed", reason: "size_mismatch" };
    }
    if (stored.sha256 !== null) {
      return stored.sha256 === row.sha256
        ? { kind: "ok", via: "store" }
        : { kind: "failed", reason: "checksum_mismatch" };
    }
    // The store did not record the checksum, so it may not have checked it either: hash the bytes.
    if (row.bytes > deps.config.assetVerifyMaxBytes) {
      return { kind: "failed", reason: "unverifiable" };
    }
    const actual = await hashStream(
      await storage.getStream(row.storageKey),
      deps.config.assetVerifyMaxBytes,
    );
    if (actual === null) {
      return { kind: "failed", reason: "size_mismatch" };
    }
    return actual === row.sha256
      ? { kind: "ok", via: "hash" }
      : { kind: "failed", reason: "checksum_mismatch" };
  }

  function requireStorage(): void {
    if (!storage.configured) {
      throw storageUnavailable();
    }
  }

  async function getRow(id: string, executor: Executor = db): Promise<AssetRow | null> {
    const [row] = await executor.select().from(assets).where(eq(assets.id, id)).limit(1);
    return row ?? null;
  }

  return {
    async createUpload(input, actor) {
      requireStorage();
      const sha256 = input.sha256.toLowerCase();
      const request = { ...input, sha256 };
      const storageKey = assetStorageKey(
        { workspaceId: input.workspaceId, itemId: input.itemId ?? null },
        input.kind,
        sha256,
        input.mime,
      );

      const { row, created } = await transaction(db, async (tx) => {
        await requireActiveWorkspace(tx, input.workspaceId);
        if (input.itemId !== undefined) {
          await requireItemOfWorkspace(tx, input.workspaceId, input.itemId);
        }

        const live = await findLive(tx, request);
        if (live !== null) {
          return { row: await existing(tx, live), created: false };
        }

        const fresh = {
          workspaceId: input.workspaceId,
          itemId: input.itemId ?? null,
          kind: input.kind,
          status: "pending" as const,
          bucket: storage.bucket,
          storageKey,
          filename: input.filename,
          mime: input.mime,
          bytes: input.bytes,
          sha256,
          width: null,
          height: null,
          durationMs: null,
          meta: {},
          createdByJob: actor.jobId ?? null,
          createdByUser: actor.userId,
          finalizedAt: null,
        };

        // A failed upload of the same file left its row on this key: start that row over.
        const [failed] = await tx
          .select()
          .from(assets)
          .where(and(eq(assets.storageKey, storageKey), eq(assets.status, "failed")))
          .limit(1)
          .for("update");
        let row: AssetRow | undefined;
        if (failed !== undefined) {
          [row] = await tx
            .update(assets)
            .set({ ...fresh, createdAt: sql`now()` })
            .where(and(eq(assets.id, failed.id), eq(assets.status, "failed")))
            .returning();
        } else {
          [row] = await tx.insert(assets).values(fresh).onConflictDoNothing().returning();
        }
        if (row === undefined) {
          // A concurrent request created the same asset first.
          const winner = await findLive(tx, request);
          if (winner === null) {
            throw conflict("Another upload of this file is starting. Try again.");
          }
          return { row: await existing(tx, winner), created: false };
        }

        await audit(tx, {
          actorKind: actor.kind,
          actorId: actor.id,
          action: "asset.upload_requested",
          targetType: "asset",
          targetId: row.id,
          data: { kind: row.kind, bytes: row.bytes, itemId: row.itemId },
          ip: actor.ip ?? null,
        });
        publish(tx, row);
        return { row, created: true };
      });

      return {
        asset: toAsset(row),
        upload: row.status === "ready" ? null : await presign(row),
        created,
      };
    },

    async finalize(id, input, actor) {
      const row = await getRow(id);
      if (row === null) {
        return null;
      }
      if (input.alignment !== undefined && row.kind !== "voice") {
        throw validationFailed([
          { path: "alignment", message: "Only voice takes have an alignment" },
        ]);
      }
      if (row.status === "ready") {
        return toAsset(row);
      }
      if (row.status === "failed") {
        throw conflict("This upload failed verification. Start a new upload.", {
          reason: "failed",
        });
      }
      requireStorage();

      const verification = await verify(row);
      if (verification.kind === "missing") {
        throw conflict("The file has not been uploaded yet. PUT it to the upload URL first.", {
          reason: "upload_missing",
        });
      }

      const ok = verification.kind === "ok";
      const meta: AssetMeta = ok
        ? {
            ...(input.probe === undefined ? {} : { probe: input.probe }),
            ...(input.alignment === undefined ? {} : { alignment: input.alignment }),
          }
        : {};
      const updated = await transaction(db, async (tx) => {
        const [next] = await tx
          .update(assets)
          .set(
            ok
              ? {
                  status: "ready",
                  meta,
                  width: input.probe?.width ?? null,
                  height: input.probe?.height ?? null,
                  durationMs: input.probe?.durationMs ?? null,
                  finalizedAt: sql`now()`,
                }
              : { status: "failed", finalizedAt: sql`now()` },
          )
          .where(and(eq(assets.id, id), eq(assets.status, "pending")))
          .returning();
        if (next === undefined) {
          return null;
        }
        await audit(tx, {
          actorKind: actor.kind,
          actorId: actor.id,
          action: ok ? "asset.finalized" : "asset.verification_failed",
          targetType: "asset",
          targetId: id,
          data: ok ? { verifiedBy: verification.via } : { reason: verification.reason },
          ip: actor.ip ?? null,
        });
        publish(tx, next);
        return next;
      });

      if (updated === null) {
        // Finalized concurrently: answer with whatever that request decided.
        const current = await getRow(id);
        return current === null ? null : toAsset(current);
      }
      if (verification.kind === "failed") {
        log.warn({ assetId: id, reason: verification.reason }, "upload failed verification");
        try {
          await storage.delete(row.storageKey);
        } catch (error) {
          log.error({ err: error, assetId: id }, "could not delete a failed upload");
        }
      }
      return toAsset(updated);
    },

    async get(id) {
      const row = await getRow(id);
      return row === null ? null : toAssetDetail(row);
    },

    getRow,

    async url(id, query = {}) {
      const row = await getRow(id);
      if (row === null) {
        return null;
      }
      if (row.status !== "ready") {
        throw conflict("The asset is not ready to download.", { reason: "not_ready" });
      }
      requireStorage();
      const signed = await storage.presignGet({
        key: row.storageKey,
        filename: row.filename,
        disposition: query.disposition ?? "inline",
      });
      return { url: signed.url, expiresAt: signed.expiresAt.toISOString() };
    },

    async listForItem(itemId, query = {}) {
      const [item] = await db
        .select({ id: contentItems.id })
        .from(contentItems)
        .where(eq(contentItems.id, itemId))
        .limit(1);
      if (item === undefined) {
        return null;
      }
      const rows = await db
        .select()
        .from(assets)
        .where(
          and(
            eq(assets.itemId, itemId),
            query.kind === undefined ? undefined : eq(assets.kind, query.kind),
          ),
        )
        .orderBy(desc(assets.createdAt), desc(assets.id));
      return rows.map(toAsset);
    },

    async cleanupPendingUploads(olderThanMs = PENDING_UPLOAD_TTL_MS) {
      if (!storage.configured) {
        return 0;
      }
      const cutoff = new Date(deps.clock.now().getTime() - olderThanMs);
      const stale = await db
        .select({ id: assets.id, storageKey: assets.storageKey })
        .from(assets)
        .where(and(eq(assets.status, "pending"), lt(assets.createdAt, cutoff)))
        .orderBy(assets.createdAt)
        .limit(CLEANUP_BATCH);
      let deleted = 0;
      for (const { id, storageKey } of stale) {
        try {
          const removed = await db
            .delete(assets)
            .where(
              and(eq(assets.id, id), eq(assets.status, "pending"), lt(assets.createdAt, cutoff)),
            )
            .returning({ id: assets.id });
          if (removed.length === 0) {
            continue;
          }
          deleted += 1;
          await storage.delete(storageKey);
        } catch (error) {
          log.error({ err: error, assetId: id }, "could not delete a stale pending upload");
        }
      }
      if (deleted > 0) {
        log.info({ deleted }, "deleted stale pending uploads");
      }
      return deleted;
    },
  };
}
