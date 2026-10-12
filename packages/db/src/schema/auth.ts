import type { TokenScope } from "@loomcast/contracts";
import { sql } from "drizzle-orm";
import { index, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, timestamptz, uuidPrimaryKey } from "./columns";
import { tokenKind, tokenScope } from "./enums";
import { users } from "./users";

/** Browser sessions. The primary key is the sha256 of the cookie token; the token is never stored. */
export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
    lastSeenAt: timestamptz("last_seen_at").notNull().defaultNow(),
    expiresAt: timestamptz("expires_at").notNull(),
    ip: text("ip"),
    userAgent: text("user_agent"),
  },
  (t) => [index("sessions_user_id_idx").on(t.userId)],
);

/**
 * Bearer tokens for MCP clients and paired devices. Only the sha256 of the secret is stored;
 * `prefix` keeps its first characters so the UI can tell tokens apart.
 */
export const apiTokens = pgTable(
  "api_tokens",
  {
    id: uuidPrimaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    kind: tokenKind("kind").notNull(),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull(),
    prefix: text("prefix").notNull(),
    scopes: tokenScope("scopes").array().$type<TokenScope[]>().notNull().default(sql`'{}'`),
    lastUsedAt: timestamptz("last_used_at"),
    expiresAt: timestamptz("expires_at"),
    revokedAt: timestamptz("revoked_at"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("api_tokens_token_hash_uq").on(t.tokenHash),
    index("api_tokens_user_id_idx").on(t.userId),
  ],
);

export type SessionRow = typeof sessions.$inferSelect;
export type NewSessionRow = typeof sessions.$inferInsert;
export type ApiTokenRow = typeof apiTokens.$inferSelect;
export type NewApiTokenRow = typeof apiTokens.$inferInsert;
