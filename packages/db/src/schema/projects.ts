import { pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, timestamptz, uuidPrimaryKey } from "./columns";
import { projectStatus } from "./enums";
import { users } from "./users";

/** The unit that owns conversations and, from M2, the knowledge base, series and content. */
export const projects = pgTable(
  "projects",
  {
    id: uuidPrimaryKey(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    status: projectStatus("status").notNull().default("active"),
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
  (t) => [uniqueIndex("projects_slug_uq").on(t.slug)],
);

export type ProjectRow = typeof projects.$inferSelect;
export type NewProjectRow = typeof projects.$inferInsert;
