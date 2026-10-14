import {
  type JsonObject,
  REFERENCE_ANALYSIS_STATUSES,
  type ReferenceAnalysis,
  type ReferenceAnalysisStatus,
  type ReferenceMediaFacts,
} from "@loomcast/contracts";
import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { assets } from "./assets";
import { apiTokens } from "./auth";
import { createdAt, timestamptz, tsvector, uuidPrimaryKey } from "./columns";
import { conversations } from "./conversations";
import { kbCreatedVia, kbEntryKind, referencePlatform } from "./enums";
import { jobs } from "./jobs";
import { projects } from "./projects";
import { users } from "./users";

/** Longest title the database accepts. The API applies the tighter `KB_TITLE_MAX_LENGTH`. */
export const KB_ENTRY_TITLE_DB_MAX_LENGTH = 300;

/**
 * Weighted search document: title (A), tags (B), body (C) and `search_extra` (D), for example a
 * reference's author and transcript. `lc_tags_text` is an IMMUTABLE wrapper around
 * `array_to_string`, which is only STABLE and so cannot appear in a generated column. Both are
 * created by the `add_kb_tables` migration.
 */
const KB_SEARCH_DOCUMENT = sql.raw(
  [
    "setweight(to_tsvector('english'::regconfig, title), 'A')",
    "setweight(to_tsvector('english'::regconfig, lc_tags_text(tags)), 'B')",
    "setweight(to_tsvector('english'::regconfig, body_md), 'C')",
    "setweight(to_tsvector('english'::regconfig, search_extra), 'D')",
  ].join(" || "),
);

/**
 * Knowledge-base entries of a project: brainstorms, references, decisions, notes and session
 * summaries. `data` holds the kind-specific fields (`KB_ENTRY_DATA` in the contracts). Entries are
 * soft-deleted; every index the API reads through excludes deleted rows.
 *
 * `dedupeKey` lets a writer insert-or-skip, for example a reference URL per project. It is unique
 * among live entries of a project, so deleting an entry frees its key.
 */
export const kbEntries = pgTable(
  "kb_entries",
  {
    id: uuidPrimaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    kind: kbEntryKind("kind").notNull(),
    title: text("title").notNull(),
    bodyMd: text("body_md").notNull().default(""),
    tags: text("tags").array().notNull().default(sql`'{}'`),
    data: jsonb("data").$type<JsonObject>().notNull().default({}),
    sourceUrl: text("source_url"),
    conversationId: uuid("conversation_id").references(() => conversations.id, {
      onDelete: "set null",
    }),
    dedupeKey: text("dedupe_key"),
    /** Extra searchable text with the lowest weight. Never shown. */
    searchExtra: text("search_extra").notNull().default(""),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    /** The MCP or job token the entry was written with, if any. */
    createdByTokenId: uuid("created_by_token_id").references(() => apiTokens.id, {
      onDelete: "set null",
    }),
    createdVia: kbCreatedVia("created_via").notNull(),
    createdAt: createdAt(),
    updatedAt: timestamptz("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    deletedAt: timestamptz("deleted_at"),
    search: tsvector("search").generatedAlwaysAs(KB_SEARCH_DOCUMENT),
  },
  (t) => [
    index("kb_entries_search_idx").using("gin", t.search),
    index("kb_entries_title_trgm_idx").using("gin", t.title.op("gin_trgm_ops")),
    index("kb_entries_tags_idx").using("gin", t.tags),
    index("kb_entries_project_id_kind_updated_at_idx")
      .on(t.projectId, t.kind, t.updatedAt.desc())
      .where(sql`${t.deletedAt} is null`),
    uniqueIndex("kb_entries_project_id_dedupe_key_uq")
      .on(t.projectId, t.dedupeKey)
      .where(sql`${t.dedupeKey} is not null and ${t.deletedAt} is null`),
    check(
      "kb_entries_title_length_ck",
      sql`char_length(${t.title}) <= ${sql.raw(String(KB_ENTRY_TITLE_DB_MAX_LENGTH))}`,
    ),
  ],
);

const ANALYSIS_STATUS_LIST = sql.raw(
  REFERENCE_ANALYSIS_STATUSES.map((status) => `'${status}'`).join(", "),
);

/**
 * The reference part of a `reference` entry, one row per entry. The transcript is untrusted text
 * supplied by the user. `analysis` is written by the `kb.analyze_reference` job, whose progress
 * `analysisStatus` mirrors.
 */
export const kbReferences = pgTable(
  "kb_references",
  {
    entryId: uuid("entry_id")
      .primaryKey()
      .references(() => kbEntries.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    platform: referencePlatform("platform").notNull(),
    author: text("author"),
    likedReason: text("liked_reason"),
    transcript: text("transcript"),
    analysis: jsonb("analysis").$type<ReferenceAnalysis>(),
    analysisStatus: text("analysis_status")
      .$type<ReferenceAnalysisStatus>()
      .notNull()
      .default("none"),
    analysisJobId: uuid("analysis_job_id").references(() => jobs.id, { onDelete: "set null" }),
    analyzedAt: timestamptz("analyzed_at"),
    /** What the studio agent measured on the media it analysed (length, cuts, words per minute). */
    mediaFacts: jsonb("media_facts").$type<ReferenceMediaFacts>(),
    /** Uploaded `reference_media` the analysis can transcribe instead of a pasted transcript. */
    mediaAssetId: uuid("media_asset_id").references(() => assets.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [
    check(
      "kb_references_analysis_status_ck",
      sql`${t.analysisStatus} in (${ANALYSIS_STATUS_LIST})`,
    ),
  ],
);

export type KbEntryRow = typeof kbEntries.$inferSelect;
export type NewKbEntryRow = typeof kbEntries.$inferInsert;
export type KbReferenceRow = typeof kbReferences.$inferSelect;
export type NewKbReferenceRow = typeof kbReferences.$inferInsert;
