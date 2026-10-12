import { timestamp, uuid } from "drizzle-orm/pg-core";

// Shared column builders. TypeScript names are camelCase; the SQL names passed here are snake_case.

/** `timestamptz`, read and written as `Date`. */
export function timestamptz(name: string) {
  return timestamp(name, { withTimezone: true, mode: "date" });
}

/** `id uuid primary key default gen_random_uuid()`. */
export function uuidPrimaryKey() {
  return uuid("id").primaryKey().defaultRandom();
}

/** `created_at timestamptz not null default now()`, present on every table. */
export function createdAt() {
  return timestamptz("created_at").notNull().defaultNow();
}
