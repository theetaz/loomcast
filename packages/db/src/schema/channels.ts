import type { JsonObject, PublishError } from "@loomcast/contracts";
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { bytea, createdAt, timestamptz, uuidPrimaryKey } from "./columns";
import { channelStatus, platform } from "./enums";
import { series } from "./formats";
import { users } from "./users";

/** Longest display name the database accepts. The API applies the tighter `CHANNEL_NAME_MAX_LENGTH`. */
export const CHANNEL_DISPLAY_NAME_DB_MAX_LENGTH = 200;

/** Length of an AES-GCM nonce, as the token vault writes it. */
export const CHANNEL_SECRET_NONCE_BYTES = 12;

/** Length of the AES-GCM authentication tag the vault appends to the ciphertext. */
export const CHANNEL_SECRET_TAG_BYTES = 16;

/**
 * An account the publisher posts to: a Facebook Page, an Instagram professional account, a Threads
 * profile or an X account. Channels belong to the workspace, not to a project; series link to them
 * through `series_channels`.
 *
 * **Credentials.** The platform tokens are stored only as AES-256-GCM ciphertext
 * (`secretCiphertext`, the encrypted JSON with the 16-byte tag appended), its 12-byte nonce
 * (`secretNonce`) and the version of the key that encrypted them (`keyVersion`). There is no
 * plaintext column, and the three are set or cleared together (`channels_secret_ck`). The API's
 * token vault encrypts with the additional data `channel:<id>`, so a ciphertext copied to another
 * row does not decrypt. Never select these columns into a response or a log line.
 *
 * **Status.** An `active` channel has stored credentials and a `disconnected` one has none
 * (`channels_status_secret_ck`); `needs_reauth` and `disabled` may have either. `dryRun` is on
 * from creation: the publisher only records what it would send until a person switches it off.
 *
 * **Parent.** An Instagram account published through a Facebook Page points at the Page's channel
 * with `parentChannelId`; it keeps its own copy of the Page token.
 *
 * **Health.** `lastVerifiedAt` and `lastError` record the daily credential check; `rateLimit` keeps
 * the platform's last usage report. None of them holds a credential.
 */
export const channels = pgTable(
  "channels",
  {
    id: uuidPrimaryKey(),
    platform: platform("platform").notNull(),
    displayName: text("display_name").notNull(),
    /** The platform's id of the Page, professional account or profile; null until connected. */
    externalId: text("external_id"),
    /** The account's handle on the platform, when it has one. */
    username: text("username"),
    parentChannelId: uuid("parent_channel_id").references((): AnyPgColumn => channels.id, {
      onDelete: "set null",
    }),
    status: channelStatus("status").notNull().default("disconnected"),
    dryRun: boolean("dry_run").notNull().default(true),
    requiresApproval: boolean("requires_approval").notNull().default(false),
    secretCiphertext: bytea("secret_ciphertext"),
    secretNonce: bytea("secret_nonce"),
    keyVersion: integer("key_version"),
    /** Permissions the stored credentials were granted. */
    scopes: text("scopes").array().notNull().default(sql`'{}'::text[]`),
    tokenExpiresAt: timestamptz("token_expires_at"),
    /**
     * Platform details that need no column of their own, such as `picture`: the platform's
     * address of the account's profile picture.
     */
    meta: jsonb("meta").$type<JsonObject>().notNull().default({}),
    /** When the daily check last found the credentials valid; null until the first check. */
    lastVerifiedAt: timestamptz("last_verified_at"),
    /**
     * Why the platform last refused the credentials, such as the `auth` error that set
     * `needs_reauth`. Cleared when a check or a reconnect succeeds.
     */
    lastError: jsonb("last_error").$type<PublishError>(),
    /**
     * The platform's latest usage report for the account (the throttling headers of its last
     * call), so the publisher can hold back before a limit is reached. Null until the first call.
     */
    rateLimit: jsonb("rate_limit").$type<JsonObject>(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: timestamptz("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    disabledAt: timestamptz("disabled_at"),
  },
  (t) => [
    uniqueIndex("channels_platform_external_id_uq")
      .on(t.platform, t.externalId)
      .where(sql`${t.externalId} is not null`),
    index("channels_parent_channel_id_idx")
      .on(t.parentChannelId)
      .where(sql`${t.parentChannelId} is not null`),
    check(
      "channels_display_name_ck",
      sql`char_length(${t.displayName}) between 1 and ${sql.raw(String(CHANNEL_DISPLAY_NAME_DB_MAX_LENGTH))}`,
    ),
    check(
      "channels_secret_ck",
      sql`num_nulls(${t.secretCiphertext}, ${t.secretNonce}, ${t.keyVersion}) in (0, 3)`,
    ),
    check(
      "channels_secret_nonce_ck",
      sql`octet_length(${t.secretNonce}) = ${sql.raw(String(CHANNEL_SECRET_NONCE_BYTES))}`,
    ),
    check(
      "channels_secret_ciphertext_ck",
      sql`octet_length(${t.secretCiphertext}) > ${sql.raw(String(CHANNEL_SECRET_TAG_BYTES))}`,
    ),
    check("channels_key_version_ck", sql`${t.keyVersion} >= 1`),
    check(
      "channels_status_secret_ck",
      sql`case ${t.status}::text when 'active' then ${t.secretCiphertext} is not null when 'disconnected' then ${t.secretCiphertext} is null else true end`,
    ),
    check("channels_parent_ck", sql`${t.parentChannelId} <> ${t.id}`),
    check("channels_last_error_ck", sql`jsonb_typeof(${t.lastError}) = 'object'`),
    check("channels_rate_limit_ck", sql`jsonb_typeof(${t.rateLimit}) = 'object'`),
  ],
);

/**
 * The channels a series publishes to. A disabled link keeps the posts it already has but plans no
 * new ones. Deleting the series or the channel removes the link.
 */
export const seriesChannels = pgTable(
  "series_channels",
  {
    seriesId: uuid("series_id")
      .notNull()
      .references(() => series.id, { onDelete: "cascade" }),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ name: "series_channels_pk", columns: [t.seriesId, t.channelId] }),
    index("series_channels_channel_id_idx").on(t.channelId),
  ],
);

export type ChannelRow = typeof channels.$inferSelect;
export type NewChannelRow = typeof channels.$inferInsert;
export type SeriesChannelRow = typeof seriesChannels.$inferSelect;
export type NewSeriesChannelRow = typeof seriesChannels.$inferInsert;
