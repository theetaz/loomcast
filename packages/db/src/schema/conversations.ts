import { index, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { createdAt, timestamptz, uuidPrimaryKey } from "./columns";
import { devices } from "./devices";
import { projects } from "./projects";
import { users } from "./users";

/**
 * A chat thread with the producer. `producerSessionId` and `deviceId` give session affinity: the
 * next turn resumes the same producer session on the same studio agent.
 */
export const conversations = pgTable(
  "conversations",
  {
    id: uuidPrimaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id),
    title: text("title"),
    producerSessionId: text("producer_session_id"),
    deviceId: uuid("device_id").references(() => devices.id, { onDelete: "set null" }),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    lastMessageAt: timestamptz("last_message_at"),
  },
  (t) => [
    // Drizzle emits `DESC NULLS LAST`; list queries must order the same way to use the index.
    index("conversations_project_id_last_message_at_idx").on(t.projectId, t.lastMessageAt.desc()),
  ],
);

export type ConversationRow = typeof conversations.$inferSelect;
export type NewConversationRow = typeof conversations.$inferInsert;
