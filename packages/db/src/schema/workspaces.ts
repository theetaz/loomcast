import { sql } from "drizzle-orm";
import { check, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { bytea, createdAt, timestamptz, uuidPrimaryKey } from "./columns";
import { workspaceColor, workspaceStatus } from "./enums";
import { users } from "./users";

/** Largest icon the database accepts, in bytes. The API applies `WORKSPACE_ICON_MAX_BYTES`. */
export const WORKSPACE_ICON_DB_MAX_BYTES = 512 * 1024;

/**
 * The unit that owns everything a brand publishes: its channels, series, content, knowledge base,
 * conversations, competitors and API clients. Every signed-in user sees every workspace.
 *
 * **Appearance.** `color` names the accent; `icon` is an optional square image (PNG, JPEG or WebP)
 * with its `iconMime`, set or cleared together. `iconUpdatedAt` versions the icon's URL so browsers
 * fetch a new image after a change. `timeZone` is where the calendar and new schedules start.
 */
export const workspaces = pgTable(
  "workspaces",
  {
    id: uuidPrimaryKey(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    status: workspaceStatus("status").notNull().default("active"),
    color: workspaceColor("color").notNull().default("thread"),
    icon: bytea("icon"),
    iconMime: text("icon_mime"),
    iconUpdatedAt: timestamptz("icon_updated_at"),
    timeZone: text("time_zone").notNull().default("UTC"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    updatedAt: timestamptz("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    archivedAt: timestamptz("archived_at"),
  },
  (t) => [
    uniqueIndex("workspaces_slug_uq").on(t.slug),
    check(
      "workspaces_icon_ck",
      sql`num_nulls(${t.icon}, ${t.iconMime}, ${t.iconUpdatedAt}) in (0, 3)`,
    ),
    check(
      "workspaces_icon_size_ck",
      sql`octet_length(${t.icon}) between 1 and ${sql.raw(String(WORKSPACE_ICON_DB_MAX_BYTES))}`,
    ),
    check(
      "workspaces_icon_mime_ck",
      sql`${t.iconMime} in ('image/png', 'image/jpeg', 'image/webp')`,
    ),
  ],
);

export type WorkspaceRow = typeof workspaces.$inferSelect;
export type NewWorkspaceRow = typeof workspaces.$inferInsert;
