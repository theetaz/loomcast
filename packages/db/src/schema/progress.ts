import type { ProgressCheck, ProgressStep } from "@loomcast/contracts";
import { sql } from "drizzle-orm";
import { bigint, boolean, check, index, jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { assets } from "./assets";
import { createdAt, timestamptz } from "./columns";
import { contentItems } from "./content";
import { workspaces } from "./workspaces";

/**
 * Production progress of an item, reported by a producer outside Loomcast (`progress.report`),
 * such as Content Machine on the owner's Mac. One row per item. It sits beside the item and never
 * changes its pipeline state. `revision` comes from the producer and only goes up: a report with
 * an equal or lower revision is ignored. `preview_asset_id` is a ready asset of the same item.
 */
export const contentProgress = pgTable(
  "content_progress",
  {
    itemId: uuid("item_id")
      .primaryKey()
      .references(() => contentItems.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    source: text("source").notNull(),
    path: text("path").notNull(),
    style: text("style"),
    steps: jsonb("steps").$type<ProgressStep[]>().notNull(),
    checks: jsonb("checks").$type<ProgressCheck[]>().notNull().default([]),
    previewAssetId: uuid("preview_asset_id").references(() => assets.id, {
      onDelete: "set null",
    }),
    revision: bigint("revision", { mode: "number" }).notNull(),
    inferred: boolean("inferred").notNull().default(false),
    reportedAt: timestamptz("reported_at").notNull(),
    createdAt: createdAt(),
    updatedAt: timestamptz("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("content_progress_workspace_id_updated_at_idx").on(t.workspaceId, t.updatedAt.desc()),
    index("content_progress_preview_asset_id_idx").on(t.previewAssetId),
    check("content_progress_revision_ck", sql`${t.revision} >= 0`),
  ],
);

export type ContentProgressRow = typeof contentProgress.$inferSelect;
