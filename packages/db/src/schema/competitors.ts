import {
  COMPETITOR_PLATFORMS,
  COMPETITOR_SCAN_SOURCES,
  COMPETITOR_SCAN_STATUSES,
  type CompetitorPlatform,
  type CompetitorScanError,
  type CompetitorScanSource,
  type CompetitorScanStatus,
} from "@loomcast/contracts";
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
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
import { jobs } from "./jobs";
import { kbEntries } from "./kb";
import { users } from "./users";
import { workspaces } from "./workspaces";

function inList(values: readonly string[]) {
  return sql.raw(values.map((value) => `'${value}'`).join(", "));
}

/**
 * Competitor profiles a workspace follows. Soft-deleted, so a profile can be followed again; the
 * handle is unique per workspace and platform among live rows, compared without case. The account
 * fields are the last values the official API reported.
 */
export const competitors = pgTable(
  "competitors",
  {
    id: uuidPrimaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    platform: text("platform").$type<CompetitorPlatform>().notNull(),
    handle: text("handle").notNull(),
    profileUrl: text("profile_url").notNull(),
    notes: text("notes"),
    displayName: text("display_name"),
    followersCount: bigint("followers_count", { mode: "number" }),
    mediaCount: integer("media_count"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: timestamptz("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    deletedAt: timestamptz("deleted_at"),
  },
  (t) => [
    uniqueIndex("competitors_workspace_id_platform_handle_uq")
      .on(t.workspaceId, t.platform, sql`lower(${t.handle})`)
      .where(sql`${t.deletedAt} is null`),
    index("competitors_workspace_id_idx").on(t.workspaceId).where(sql`${t.deletedAt} is null`),
    check("competitors_platform_ck", sql`${t.platform} in (${inList(COMPETITOR_PLATFORMS)})`),
  ],
);

/**
 * One scan of a competitor: the videos it picked (`competitor_scan_videos`), whose analyses run as
 * `kb.analyze_reference` jobs, then the `kb.competitor_report` job and the note it wrote.
 */
export const competitorScans = pgTable(
  "competitor_scans",
  {
    id: uuidPrimaryKey(),
    competitorId: uuid("competitor_id")
      .notNull()
      .references(() => competitors.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    status: text("status").$type<CompetitorScanStatus>().notNull(),
    source: text("source").$type<CompetitorScanSource>().notNull(),
    topN: integer("top_n").notNull(),
    /** The Instagram channel whose token ranked the videos, for `official_api` scans. */
    channelId: uuid("channel_id").references(() => channels.id, { onDelete: "set null" }),
    reportJobId: uuid("report_job_id").references(() => jobs.id, { onDelete: "set null" }),
    reportEntryId: uuid("report_entry_id").references(() => kbEntries.id, {
      onDelete: "set null",
    }),
    error: jsonb("error").$type<CompetitorScanError>(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    finishedAt: timestamptz("finished_at"),
  },
  (t) => [
    index("competitor_scans_competitor_id_created_at_idx").on(t.competitorId, t.createdAt.desc()),
    index("competitor_scans_report_job_id_idx").on(t.reportJobId),
    uniqueIndex("competitor_scans_one_active_uq")
      .on(t.competitorId)
      .where(sql`${t.status} in ('analyzing', 'reporting')`),
    check("competitor_scans_status_ck", sql`${t.status} in (${inList(COMPETITOR_SCAN_STATUSES)})`),
    check("competitor_scans_source_ck", sql`${t.source} in (${inList(COMPETITOR_SCAN_SOURCES)})`),
    check("competitor_scans_top_n_ck", sql`${t.topN} between 1 and 20`),
  ],
);

/**
 * A video a scan picked, with the numbers it had then. Its analysis lives on the reference entry;
 * the same video in a later scan points at the same entry.
 */
export const competitorScanVideos = pgTable(
  "competitor_scan_videos",
  {
    scanId: uuid("scan_id")
      .notNull()
      .references(() => competitorScans.id, { onDelete: "cascade" }),
    entryId: uuid("entry_id")
      .notNull()
      .references(() => kbEntries.id, { onDelete: "cascade" }),
    rank: integer("rank").notNull(),
    /** The analysis job this scan waits for; null when an earlier analysis was reused. */
    analysisJobId: uuid("analysis_job_id").references(() => jobs.id, { onDelete: "set null" }),
    externalId: text("external_id"),
    url: text("url").notNull(),
    caption: text("caption"),
    views: bigint("views", { mode: "number" }),
    likes: bigint("likes", { mode: "number" }),
    comments: bigint("comments", { mode: "number" }),
    postedAt: timestamptz("posted_at"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("competitor_scan_videos_scan_id_entry_id_uq").on(t.scanId, t.entryId),
    uniqueIndex("competitor_scan_videos_scan_id_rank_uq").on(t.scanId, t.rank),
    index("competitor_scan_videos_entry_id_idx").on(t.entryId),
    index("competitor_scan_videos_analysis_job_id_idx").on(t.analysisJobId),
  ],
);

export type CompetitorRow = typeof competitors.$inferSelect;
export type NewCompetitorRow = typeof competitors.$inferInsert;
export type CompetitorScanRow = typeof competitorScans.$inferSelect;
export type CompetitorScanVideoRow = typeof competitorScanVideos.$inferSelect;
