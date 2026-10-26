import type { PostOptions } from "@loomcast/contracts";
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uuid,
} from "drizzle-orm/pg-core";
import { apiTokens } from "./auth";
import { channels } from "./channels";
import { createdAt, timestamptz } from "./columns";
import { contentItems } from "./content";
import { apiChannelAccess, postFormat } from "./enums";

/**
 * The channels an API client (an `api` token) may use, and how far: `read`, `write` or
 * `publish` (cumulative, see `API_CHANNEL_ACCESS`). A client reaches no channel without a row
 * here. Revoking the token or deleting the channel deletes the grant. Both keys carry the
 * workspace, so a client is only ever granted channels of its own workspace.
 */
export const apiTokenChannels = pgTable(
  "api_token_channels",
  {
    workspaceId: uuid("workspace_id").notNull(),
    tokenId: uuid("token_id").notNull(),
    channelId: uuid("channel_id").notNull(),
    access: apiChannelAccess("access").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.tokenId, t.channelId] }),
    index("api_token_channels_channel_id_idx").on(t.channelId),
    foreignKey({
      name: "api_token_channels_token_fk",
      columns: [t.workspaceId, t.tokenId],
      foreignColumns: [apiTokens.workspaceId, apiTokens.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "api_token_channels_channel_fk",
      columns: [t.workspaceId, t.channelId],
      foreignColumns: [channels.workspaceId, channels.id],
    }).onDelete("cascade"),
  ],
);

/** One file an API client declared for a post, in order. The asset is found by its SHA-256. */
export interface ApiPostMediaEntry {
  filename: string;
  mime: string;
  bytes: number;
  /** Lowercase hex; the item's `media` asset with this checksum holds the file. */
  sha256: string;
  /** What the client declared about the file; stored as the asset's probe on finalize. */
  width?: number;
  height?: number;
  durationMs?: number;
  altText?: string;
}

/** One channel an API client asked a post to go out on, with the post's options there. */
export interface ApiPostChannelEntry {
  channelId: string;
  options?: PostOptions;
}

/**
 * A post an API client created through the machine API: the content item, and what the client
 * asked for until the post is finalized (its files, its channels and its time). `finalizedAt` is
 * set once the version is written and the posts exist; from then on the item and its scheduled
 * posts are the truth. `cancelledAt` is set when the client withdraws a post before or after
 * that. Deleting the item or the token deletes the row.
 */
export const apiPosts = pgTable(
  "api_posts",
  {
    itemId: uuid("item_id")
      .primaryKey()
      .references(() => contentItems.id, { onDelete: "cascade" }),
    tokenId: uuid("token_id")
      .notNull()
      .references(() => apiTokens.id, { onDelete: "cascade" }),
    /** The client's own reference for the post, returned as given. */
    externalRef: text("external_ref"),
    format: postFormat("format").notNull(),
    caption: text("caption"),
    media: jsonb("media").$type<ApiPostMediaEntry[]>().notNull().default([]),
    targets: jsonb("targets").$type<ApiPostChannelEntry[]>().notNull().default([]),
    scheduledAt: timestamptz("scheduled_at").notNull(),
    finalizedAt: timestamptz("finalized_at"),
    cancelledAt: timestamptz("cancelled_at"),
    createdAt: createdAt(),
  },
  (t) => [
    index("api_posts_token_id_created_at_idx").on(t.tokenId, t.createdAt.desc(), t.itemId),
    check("api_posts_media_ck", sql`jsonb_typeof(${t.media}) = 'array'`),
    check("api_posts_targets_ck", sql`jsonb_typeof(${t.targets}) = 'array'`),
  ],
);

/**
 * `Idempotency-Key`s of `POST /api/v1/posts`, per API client. A key is stored in the transaction
 * that creates the post, with the hash of the request body, so a retry with the same key and body
 * gets the same post and a retry with another body is refused. A failed request stores nothing.
 * Keys expire after `API_IDEMPOTENCY_TTL_MS`.
 */
export const apiIdempotencyKeys = pgTable(
  "api_idempotency_keys",
  {
    tokenId: uuid("token_id")
      .notNull()
      .references(() => apiTokens.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    /** sha256 of the canonical JSON of the request body. */
    requestHash: text("request_hash").notNull(),
    itemId: uuid("item_id")
      .notNull()
      .references(() => contentItems.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.tokenId, t.key] }),
    index("api_idempotency_keys_created_at_idx").on(t.createdAt),
  ],
);

export type ApiTokenChannelRow = typeof apiTokenChannels.$inferSelect;
export type ApiPostRow = typeof apiPosts.$inferSelect;
export type NewApiPostRow = typeof apiPosts.$inferInsert;
export type ApiIdempotencyKeyRow = typeof apiIdempotencyKeys.$inferSelect;
