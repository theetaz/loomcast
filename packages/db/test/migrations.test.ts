import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATIONS_FOLDER, migrate } from "../src/migrate";
import { createTestDb, type TestDb } from "../src/testing";

const TABLES = [
  "api_tokens",
  "audit_log",
  "conversations",
  "devices",
  "job_events",
  "jobs",
  "kb_entries",
  "kb_references",
  "messages",
  "pairing_codes",
  "password_tokens",
  "projects",
  "sessions",
  "users",
];

const journal = JSON.parse(
  readFileSync(join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8"),
) as { entries: unknown[] };

async function publicTables(testDb: TestDb): Promise<string[]> {
  const result = await testDb.db.execute<{ table_name: string }>(
    sql`select table_name from information_schema.tables
        where table_schema = 'public' order by table_name`,
  );
  return result.rows.map((row) => row.table_name);
}

async function appliedMigrations(testDb: TestDb): Promise<number> {
  const result = await testDb.db.execute<{ count: number }>(
    sql`select count(*)::int as count from drizzle.__drizzle_migrations`,
  );
  return result.rows[0]?.count ?? 0;
}

describe("migrations", () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await createTestDb({ empty: true });
  });

  afterAll(async () => {
    await testDb.drop();
  });

  it("apply to an empty database and create every table", async () => {
    expect(await publicTables(testDb)).toEqual([]);

    await migrate(testDb.url);

    expect(await publicTables(testDb)).toEqual(TABLES);
    expect(await appliedMigrations(testDb)).toBe(journal.entries.length);
  });

  it("are a no-op when run again", async () => {
    await migrate(testDb.url);

    expect(await publicTables(testDb)).toEqual(TABLES);
    expect(await appliedMigrations(testDb)).toBe(journal.entries.length);
  });

  it("create the pg enums from the contracts value arrays", async () => {
    const result = await testDb.db.execute<{ values: string }>(
      sql`select string_agg(enumlabel, ',' order by enumsortorder) as values
          from pg_enum join pg_type on pg_type.oid = pg_enum.enumtypid
          where typname = 'job_status'`,
    );
    expect(result.rows[0]?.values).toBe("queued,dispatched,running,succeeded,failed,cancelled");
  });
});
