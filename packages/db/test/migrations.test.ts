import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate as runMigrations } from "drizzle-orm/node-postgres/migrator";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATIONS_FOLDER, migrate } from "../src/migrate";
import { apiTokens, jobs } from "../src/schema";
import { createTestDb, type TestDb } from "../src/testing";
import { apiTokenValues, insertProject, insertUser } from "./fixtures";

const TABLES = [
  "api_tokens",
  "assets",
  "audit_log",
  "channels",
  "content_items",
  "content_versions",
  "conversations",
  "devices",
  "format_versions",
  "formats",
  "job_events",
  "jobs",
  "kb_entries",
  "kb_references",
  "messages",
  "pairing_codes",
  "password_tokens",
  "projects",
  "reviews",
  "series",
  "series_channels",
  "sessions",
  "skill_versions",
  "skills",
  "users",
];

const journal = JSON.parse(
  readFileSync(join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8"),
) as { entries: { tag: string }[] };

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

describe("migrations on a database from before the knowledge base", () => {
  let testDb: TestDb;
  let m1Folder: string;

  beforeAll(async () => {
    testDb = await createTestDb({ empty: true });
    // A copy of the migrations folder as it was in M1: only 0000_init.
    m1Folder = mkdtempSync(join(tmpdir(), "loomcast-m1-migrations-"));
    mkdirSync(join(m1Folder, "meta"));
    const [first] = journal.entries;
    if (first === undefined) throw new Error("the journal has no entries");
    copyFileSync(join(MIGRATIONS_FOLDER, `${first.tag}.sql`), join(m1Folder, `${first.tag}.sql`));
    writeFileSync(
      join(m1Folder, "meta", "_journal.json"),
      JSON.stringify({ ...journal, entries: [first] }),
    );
  });

  afterAll(async () => {
    await testDb.drop();
    rmSync(m1Folder, { recursive: true, force: true });
  });

  it("apply in one batch, although the new enum values are added in the same transaction", async () => {
    const client = new Client({ connectionString: testDb.url });
    await client.connect();
    try {
      await runMigrations(drizzle({ client }), { migrationsFolder: m1Folder });
    } finally {
      await client.end();
    }
    // Rows in the M1 shape: the current schema names columns that do not exist yet.
    const user = await insertUser(testDb.db);
    const m1Token = apiTokenValues({ userId: user.id, kind: "mcp" });
    await testDb.db.execute(
      sql`insert into api_tokens (user_id, kind, name, token_hash, prefix, scopes)
          values (${user.id}, 'mcp', ${m1Token.name}, ${m1Token.tokenHash}, ${m1Token.prefix},
                  '{mcp:read}')`,
    );

    await migrate(testDb.url);

    expect(await publicTables(testDb)).toEqual(TABLES);
    expect(await appliedMigrations(testDb)).toBe(journal.entries.length);
    const project = await insertProject(testDb.db, user.id);
    const [job] = await testDb.db
      .insert(jobs)
      .values({
        type: "kb.analyze_reference",
        payload: {},
        projectId: project.id,
        createdBy: user.id,
      })
      .returning();
    await testDb.db
      .insert(apiTokens)
      .values(
        apiTokenValues({ userId: user.id, kind: "job", projectId: project.id, jobId: job?.id }),
      );
  });
});
