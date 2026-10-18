import {
  RESEARCH_ACCOUNT_SOURCES,
  RESEARCH_PLATFORMS,
  RESEARCH_VIDEO_SOURCES,
  type ResearchAccountSource,
  type ResearchPlatform,
  type ResearchVideoSource,
} from "@loomcast/contracts";
import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  check,
  doublePrecision,
  index,
  pgTable,
  real,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, timestamptz, uuidPrimaryKey } from "./columns";
import { competitors } from "./competitors";
import { workspaces } from "./workspaces";

function inList(values: readonly string[]) {
  return sql.raw(values.map((value) => `'${value}'`).join(", "));
}

function nonNegative(...columns: unknown[]) {
  return sql.join(
    columns.map((column) => sql`coalesce(${column}, 0) >= 0`),
    sql` and `,
  );
}

/**
 * Accounts in a workspace's research: competitors followed on purpose (`tracked`) and accounts
 * whose videos an MCP client added (`discovered`). The handle is stored lowercased without `@`
 * (`research_accounts_handle_ck`), so `(workspace_id, platform, handle)` is unique as written.
 * `median_views` is the median of the account's most recent videos with views, recomputed by the
 * API whenever its videos change; `last_synced_at` is when the official API last read it.
 */
export const researchAccounts = pgTable(
  "research_accounts",
  {
    id: uuidPrimaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    platform: text("platform").$type<ResearchPlatform>().notNull(),
    handle: text("handle").notNull(),
    displayName: text("display_name"),
    followers: bigint("followers", { mode: "number" }),
    medianViews: bigint("median_views", { mode: "number" }),
    source: text("source").$type<ResearchAccountSource>().notNull(),
    competitorId: uuid("competitor_id").references(() => competitors.id, {
      onDelete: "set null",
    }),
    lastSyncedAt: timestamptz("last_synced_at"),
    notes: text("notes"),
    createdAt: createdAt(),
    updatedAt: timestamptz("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("research_accounts_workspace_id_platform_handle_uq").on(
      t.workspaceId,
      t.platform,
      t.handle,
    ),
    index("research_accounts_competitor_id_idx").on(t.competitorId),
    check("research_accounts_platform_ck", sql`${t.platform} in (${inList(RESEARCH_PLATFORMS)})`),
    check("research_accounts_source_ck", sql`${t.source} in (${inList(RESEARCH_ACCOUNT_SOURCES)})`),
    check(
      "research_accounts_handle_ck",
      sql`${t.handle} = lower(${t.handle}) and char_length(${t.handle}) between 1 and 100`,
    ),
    check("research_accounts_counts_ck", nonNegative(t.followers, t.medianViews)),
  ],
);

/**
 * Videos in a workspace's research, one row per platform video (`external_id` is the Instagram
 * shortcode, the TikTok or YouTube video id, …). The counts are the latest known totals;
 * `research_video_snapshots` keeps their history. `outlier_score` is `views / median_views` of the
 * account, recomputed with the median. `topic` is stored normalised (`normalizeTopic`), so the
 * leaderboard groups by it as is. Captions, hooks and notes are third-party text.
 */
export const researchVideos = pgTable(
  "research_videos",
  {
    id: uuidPrimaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => researchAccounts.id, { onDelete: "cascade" }),
    platform: text("platform").$type<ResearchPlatform>().notNull(),
    externalId: text("external_id").notNull(),
    url: text("url"),
    caption: text("caption"),
    postedAt: timestamptz("posted_at"),
    durationS: real("duration_s"),
    views: bigint("views", { mode: "number" }),
    likes: bigint("likes", { mode: "number" }),
    comments: bigint("comments", { mode: "number" }),
    shares: bigint("shares", { mode: "number" }),
    outlierScore: doublePrecision("outlier_score"),
    topic: text("topic"),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    hook: text("hook"),
    format: text("format"),
    notes: text("notes"),
    source: text("source").$type<ResearchVideoSource>().notNull(),
    firstSeenAt: timestamptz("first_seen_at").notNull().defaultNow(),
    createdAt: createdAt(),
    updatedAt: timestamptz("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("research_videos_workspace_id_platform_external_id_uq").on(
      t.workspaceId,
      t.platform,
      t.externalId,
    ),
    index("research_videos_account_id_posted_at_idx").on(t.accountId, t.postedAt.desc()),
    index("research_videos_workspace_id_topic_idx").on(t.workspaceId, t.topic),
    check("research_videos_platform_ck", sql`${t.platform} in (${inList(RESEARCH_PLATFORMS)})`),
    check("research_videos_source_ck", sql`${t.source} in (${inList(RESEARCH_VIDEO_SOURCES)})`),
    check(
      "research_videos_counts_ck",
      nonNegative(t.views, t.likes, t.comments, t.shares, t.outlierScore, t.durationS),
    ),
  ],
);

/** The counts of a research video each time they changed, newest first through the index. */
export const researchVideoSnapshots = pgTable(
  "research_video_snapshots",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    videoId: uuid("video_id")
      .notNull()
      .references(() => researchVideos.id, { onDelete: "cascade" }),
    capturedAt: timestamptz("captured_at").notNull().defaultNow(),
    views: bigint("views", { mode: "number" }),
    likes: bigint("likes", { mode: "number" }),
    comments: bigint("comments", { mode: "number" }),
    shares: bigint("shares", { mode: "number" }),
    createdAt: createdAt(),
  },
  (t) => [
    index("research_video_snapshots_video_id_captured_at_idx").on(t.videoId, t.capturedAt.desc()),
    check(
      "research_video_snapshots_counts_ck",
      nonNegative(t.views, t.likes, t.comments, t.shares),
    ),
  ],
);

export type ResearchAccountRow = typeof researchAccounts.$inferSelect;
export type NewResearchAccountRow = typeof researchAccounts.$inferInsert;
export type ResearchVideoRow = typeof researchVideos.$inferSelect;
export type NewResearchVideoRow = typeof researchVideos.$inferInsert;
export type ResearchVideoSnapshotRow = typeof researchVideoSnapshots.$inferSelect;
