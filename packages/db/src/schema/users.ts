import { sql } from "drizzle-orm";
import { check, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { createdAt, timestamptz, uuidPrimaryKey } from "./columns";
import { userRole } from "./enums";

/**
 * Accounts are created by the admin CLI or an owner-only MCP tool; there is no sign-up. Emails are
 * stored in lowercase, which the check constraint enforces, so the unique index is effectively
 * case-insensitive.
 */
export const users = pgTable(
  "users",
  {
    id: uuidPrimaryKey(),
    email: text("email").notNull(),
    name: text("name").notNull(),
    passwordHash: text("password_hash").notNull(),
    role: userRole("role").notNull(),
    disabledAt: timestamptz("disabled_at"),
    lastLoginAt: timestamptz("last_login_at"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("users_email_uq").on(t.email),
    check("users_email_lowercase_ck", sql`${t.email} = lower(${t.email})`),
  ],
);

export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;
