import type { JsonObject, PostOptions, PublishError } from "@loomcast/contracts";
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { channels } from "./channels";
import { createdAt, timestamptz, uuidPrimaryKey } from "./columns";
import { contentItems, contentVersions } from "./content";
import { platform, postStatus } from "./enums";
import { series } from "./formats";

/**
 * One content item on one channel at one time. A cadence slot creates the post as `planned`; it
 * becomes `queued`, with `versionId` set to the approved version, when the item is approved, and
 * goes back to `planned` (clearing `versionId`) if the item leaves `approved`. The publisher moves
 * a due post to `publishing` and then `published` or `failed`; a post still `planned` at its time
 * is `missed`.
 *
 * - **One open post per item and channel.** `scheduled_posts_item_id_channel_id_uq` covers every
 *   status except `cancelled`, so an item can be scheduled on a channel again only after its
 *   previous post there is cancelled. An `ON CONFLICT` target must repeat the predicate
 *   (`status <> 'cancelled'`).
 * - **Versions.** `versionId` must be a version of the post's item (`scheduled_posts_version_fk`),
 *   and a `queued`, `publishing` or `published` post must have one (`scheduled_posts_version_ck`).
 * - **Dry run.** `dryRun` is fixed when the post is created, from the channel's switch and the
 *   server's publishing mode.
 * - **Project, platform and publish mode** come from joins: the item's `project_id`, the channel's
 *   `platform`, and `effectivePublishMode` of the series format's `rules.publishMode` and the
 *   channel's `requires_approval`.
 *
 * The index predicates use enum literals because an index predicate must be immutable and an
 * enum-to-text cast is not; that is safe because `post_status` is created, not extended, by the
 * same migration. The checks compare as text, like every other check on an enum.
 */
export const scheduledPosts = pgTable(
  "scheduled_posts",
  {
    id: uuidPrimaryKey(),
    itemId: uuid("item_id")
      .notNull()
      .references(() => contentItems.id, { onDelete: "cascade" }),
    /** The approved version it publishes; null while the post is only planned. */
    versionId: uuid("version_id"),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id),
    seriesId: uuid("series_id").references(() => series.id, { onDelete: "set null" }),
    scheduledAt: timestamptz("scheduled_at").notNull(),
    status: postStatus("status").notNull().default("planned"),
    dryRun: boolean("dry_run").notNull().default(true),
    /** Per-platform options of this post (`PostOptionsSchema`). */
    options: jsonb("options").$type<PostOptions>().notNull().default({}),
    /** The platform's id of the published post. */
    externalId: text("external_id"),
    /** The platform's id of the upload or media container, while it processes. */
    externalContainerId: text("external_container_id"),
    permalink: text("permalink"),
    /** Publish attempts so far; `publish_attempts` holds one row per attempt. */
    attempts: integer("attempts").notNull().default(0),
    lastError: jsonb("last_error").$type<PublishError>(),
    publishedAt: timestamptz("published_at"),
    createdAt: createdAt(),
    updatedAt: timestamptz("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("scheduled_posts_item_id_channel_id_uq")
      .on(t.itemId, t.channelId)
      .where(sql`${t.status} <> 'cancelled'`),
    index("scheduled_posts_open_scheduled_at_idx")
      .on(t.scheduledAt)
      .where(sql`${t.status} in ('planned', 'queued')`),
    index("scheduled_posts_channel_id_scheduled_at_idx").on(t.channelId, t.scheduledAt),
    index("scheduled_posts_series_id_scheduled_at_idx").on(t.seriesId, t.scheduledAt),
    index("scheduled_posts_item_id_idx").on(t.itemId),
    foreignKey({
      name: "scheduled_posts_version_fk",
      columns: [t.itemId, t.versionId],
      foreignColumns: [contentVersions.itemId, contentVersions.id],
    }),
    check("scheduled_posts_attempts_ck", sql`${t.attempts} >= 0`),
    check(
      "scheduled_posts_version_ck",
      sql`${t.status}::text not in ('queued', 'publishing', 'published') or ${t.versionId} is not null`,
    ),
    check(
      "scheduled_posts_published_at_ck",
      sql`${t.status}::text <> 'published' or ${t.publishedAt} is not null`,
    ),
  ],
);

/**
 * One try at publishing a post, numbered from 1 per post. `request` is what was sent (or, in
 * dry-run, would have been sent) with every credential replaced before it is stored: the database
 * cannot check that, so the publisher must redact first. `response` is the platform's answer and
 * `error` the classified failure.
 */
export const publishAttempts = pgTable(
  "publish_attempts",
  {
    id: uuidPrimaryKey(),
    postId: uuid("post_id")
      .notNull()
      .references(() => scheduledPosts.id, { onDelete: "cascade" }),
    attempt: integer("attempt").notNull(),
    /** The platform adapter that built the request. */
    adapter: platform("adapter").notNull(),
    dryRun: boolean("dry_run").notNull(),
    request: jsonb("request").$type<JsonObject>(),
    response: jsonb("response").$type<JsonObject>(),
    error: jsonb("error").$type<PublishError>(),
    startedAt: timestamptz("started_at").notNull().defaultNow(),
    finishedAt: timestamptz("finished_at"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("publish_attempts_post_id_attempt_uq").on(t.postId, t.attempt),
    check("publish_attempts_attempt_ck", sql`${t.attempt} >= 1`),
  ],
);

export type ScheduledPostRow = typeof scheduledPosts.$inferSelect;
export type NewScheduledPostRow = typeof scheduledPosts.$inferInsert;
export type PublishAttemptRow = typeof publishAttempts.$inferSelect;
export type NewPublishAttemptRow = typeof publishAttempts.$inferInsert;
