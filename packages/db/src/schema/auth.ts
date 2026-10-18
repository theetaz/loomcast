import type { TokenScope } from "@loomcast/contracts";
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  check,
  index,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, timestamptz, uuidPrimaryKey } from "./columns";
import { passwordTokenPurpose, tokenKind, tokenScope } from "./enums";
import { jobs } from "./jobs";
import { projects } from "./projects";
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
 * Bearer tokens for MCP clients, paired devices, running jobs and API clients. Only the sha256 of
 * the secret is stored; `prefix` keeps its first characters so the UI can tell tokens apart.
 *
 * A `job` token is minted for one job and bound to its project; `jobId` is set exactly for job
 * tokens, and deleting the job deletes its token. An `api` token is an API client of the machine
 * API: it always has the project its posts are created in, and its channels are granted in
 * `api_token_channels`. Only job and API tokens have a project. The checks compare `kind` as text
 * so that they never parse an enum value a pending migration may add in the same transaction.
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
    /** The project a job token is bound to, or the project an API client creates posts in. */
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }),
    /**
     * The job a job token was minted for. Typed as `AnyPgColumn` because `jobs` reaches back to
     * this table through `devices`.
     */
    jobId: uuid("job_id").references((): AnyPgColumn => jobs.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("api_tokens_token_hash_uq").on(t.tokenHash),
    index("api_tokens_user_id_idx").on(t.userId),
    index("api_tokens_job_id_idx").on(t.jobId).where(sql`${t.jobId} is not null`),
    check("api_tokens_job_id_ck", sql`(${t.kind}::text = 'job') = (${t.jobId} is not null)`),
    check(
      "api_tokens_project_id_ck",
      sql`(${t.kind}::text <> 'api' or ${t.projectId} is not null) and (${t.kind}::text in ('job', 'api') or ${t.projectId} is null)`,
    ),
  ],
);

/**
 * One-time set-password links for invitations and resets. Only the sha256 of the secret is
 * stored. A link is valid while `usedAt` is null and `expiresAt` is in the future; issuing a new
 * link for a user invalidates the previous ones. `createdBy` is null for links made by the CLI.
 */
export const passwordTokens = pgTable(
  "password_tokens",
  {
    id: uuidPrimaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    purpose: passwordTokenPurpose("purpose").notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    expiresAt: timestamptz("expires_at").notNull(),
    usedAt: timestamptz("used_at"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("password_tokens_token_hash_uq").on(t.tokenHash),
    index("password_tokens_user_id_idx").on(t.userId),
  ],
);

export type SessionRow = typeof sessions.$inferSelect;
export type NewSessionRow = typeof sessions.$inferInsert;
export type ApiTokenRow = typeof apiTokens.$inferSelect;
export type NewApiTokenRow = typeof apiTokens.$inferInsert;
export type PasswordTokenRow = typeof passwordTokens.$inferSelect;
export type NewPasswordTokenRow = typeof passwordTokens.$inferInsert;
