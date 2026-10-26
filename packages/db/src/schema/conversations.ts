import { sql } from "drizzle-orm";
import { type AnyPgColumn, index, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { createdAt, timestamptz, uuidPrimaryKey } from "./columns";
import { contentItems } from "./content";
import { devices } from "./devices";
import { users } from "./users";
import { workspaces } from "./workspaces";

/**
 * A chat thread with the producer. `producerSessionId` and `deviceId` give session affinity: the
 * next turn resumes the same producer session on the same studio agent. `contentItemId` is set for
 * an item's own conversation.
 */
export const conversations = pgTable(
  "conversations",
  {
    id: uuidPrimaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    title: text("title"),
    producerSessionId: text("producer_session_id"),
    deviceId: uuid("device_id").references(() => devices.id, { onDelete: "set null" }),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    /** Typed as `AnyPgColumn` because `content_items` reaches back to this table through `jobs`. */
    contentItemId: uuid("content_item_id").references((): AnyPgColumn => contentItems.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
    lastMessageAt: timestamptz("last_message_at"),
  },
  (t) => [
    // Drizzle emits `DESC NULLS LAST`; list queries must order the same way to use the index.
    index("conversations_workspace_id_last_message_at_idx").on(
      t.workspaceId,
      t.lastMessageAt.desc(),
    ),
    index("conversations_content_item_id_idx")
      .on(t.contentItemId)
      .where(sql`${t.contentItemId} is not null`),
  ],
);

export type ConversationRow = typeof conversations.$inferSelect;
export type NewConversationRow = typeof conversations.$inferInsert;
