import type { AssetProbe, VoiceAlignment } from "@loomcast/contracts";
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  char,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, timestamptz, uuidPrimaryKey } from "./columns";
import { contentItems } from "./content";
import { assetKind, assetStatus } from "./enums";
import { jobs } from "./jobs";
import { users } from "./users";
import { workspaces } from "./workspaces";

/** What an asset knows besides its columns: the probe sent at finalize and a voice take's timings. */
export interface AssetMeta {
  probe?: AssetProbe;
  alignment?: VoiceAlignment;
}

/**
 * A stored file: a voice take, render, poster, frame or reference media. The bytes live in object
 * storage under `bucket` and `storageKey`, which are never exposed. An asset is `pending` until
 * its upload is finalized and its size and SHA-256 verified, then `ready` (or `failed`).
 *
 * Uploading the same bytes again returns the existing asset, within the asset's owner: an item
 * holds one live asset per kind and SHA-256 (`assets_workspace_id_item_id_kind_sha256_uq`), and the
 * workspace holds one per kind and SHA-256 among its workspace-level media, those without an item
 * (`assets_workspace_id_kind_sha256_uq`). So two items may each hold the same voice take or render,
 * and a version can always point at an asset of its own item. Failed assets are left out of both
 * indexes, so a failed upload can be retried; an `ON CONFLICT` target must repeat the index's
 * predicate. The predicates use the enum literal because an index predicate must be immutable and
 * an enum-to-text cast is not; that is safe because `asset_status` is created, not extended, by
 * the migration that created the table.
 */
export const assets = pgTable(
  "assets",
  {
    id: uuidPrimaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** The content item it belongs to; null for workspace-level media such as references. */
    itemId: uuid("item_id").references((): AnyPgColumn => contentItems.id, {
      onDelete: "cascade",
    }),
    kind: assetKind("kind").notNull(),
    status: assetStatus("status").notNull().default("pending"),
    bucket: text("bucket").notNull(),
    storageKey: text("storage_key").notNull(),
    /** The download name, without directories. */
    filename: text("filename").notNull(),
    mime: text("mime").notNull(),
    bytes: bigint("bytes", { mode: "number" }).notNull(),
    /** Lowercase hex. */
    sha256: char("sha256", { length: 64 }).notNull(),
    width: integer("width"),
    height: integer("height"),
    durationMs: integer("duration_ms"),
    meta: jsonb("meta").$type<AssetMeta>().notNull().default({}),
    createdByJob: uuid("created_by_job").references(() => jobs.id, { onDelete: "set null" }),
    createdByUser: uuid("created_by_user").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    finalizedAt: timestamptz("finalized_at"),
  },
  (t) => [
    uniqueIndex("assets_storage_key_uq").on(t.storageKey),
    uniqueIndex("assets_workspace_id_kind_sha256_uq")
      .on(t.workspaceId, t.kind, t.sha256)
      .where(sql`${t.itemId} is null and ${t.status} <> 'failed'`),
    uniqueIndex("assets_workspace_id_item_id_kind_sha256_uq")
      .on(t.workspaceId, t.itemId, t.kind, t.sha256)
      .where(sql`${t.itemId} is not null and ${t.status} <> 'failed'`),
    index("assets_item_id_created_at_idx")
      .on(t.itemId, t.createdAt.desc())
      .where(sql`${t.itemId} is not null`),
    check("assets_bytes_ck", sql`${t.bytes} >= 0`),
    check("assets_sha256_ck", sql`${t.sha256} ~ '^[0-9a-f]{64}$'`),
  ],
);

export type AssetRow = typeof assets.$inferSelect;
export type NewAssetRow = typeof assets.$inferInsert;
