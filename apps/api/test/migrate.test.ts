import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIGRATIONS_FOLDER } from "@loomcast/db";
import { createTestDb, type TestDb } from "@loomcast/db/testing";
import { Client } from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MIGRATION_LOCK_NAME,
  migrateWithLock,
  resolveMigrationsDir,
} from "../src/cli/migrate-and-start";

const journal = JSON.parse(
  readFileSync(join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8"),
) as { entries: unknown[] };
const MIGRATION_COUNT = journal.entries.length;

async function connect(url: string): Promise<Client> {
  const client = new Client({ connectionString: url });
  await client.connect();
  return client;
}

async function recordedMigrations(url: string): Promise<number> {
  const client = await connect(url);
  try {
    const table = await client.query<{ exists: boolean }>(
      "select to_regclass('drizzle.__drizzle_migrations') is not null as exists",
    );
    if (table.rows[0]?.exists !== true) {
      return 0;
    }
    const result = await client.query<{ count: number }>(
      "select count(*)::int as count from drizzle.__drizzle_migrations",
    );
    return result.rows[0]?.count ?? 0;
  } finally {
    await client.end();
  }
}

/** Polls until a session in `database` is blocked on an advisory lock. */
async function waitForBlockedAdvisoryLock(client: Client, database: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const result = await client.query(
      `select 1 from pg_locks l join pg_stat_activity a on a.pid = l.pid
        where l.locktype = 'advisory' and not l.granted and a.datname = $1`,
      [database],
    );
    if (result.rowCount !== 0) {
      return;
    }
  }
  throw new Error("no session waited for the migration lock");
}

describe("migrateWithLock", () => {
  let testDb: TestDb;

  beforeEach(async () => {
    testDb = await createTestDb({ empty: true, max: 1 });
  });

  afterEach(async () => {
    await testDb.drop();
  });

  it("applies every migration once and is a no-op on the next run", async () => {
    const first = await migrateWithLock({
      databaseUrl: testDb.url,
      migrationsDir: MIGRATIONS_FOLDER,
    });
    expect(first).toEqual({ before: 0, after: MIGRATION_COUNT });

    const second = await migrateWithLock({
      databaseUrl: testDb.url,
      migrationsDir: MIGRATIONS_FOLDER,
    });
    expect(second).toEqual({ before: MIGRATION_COUNT, after: MIGRATION_COUNT });
  });

  it("serialises two runs that start at the same time", async () => {
    const options = { databaseUrl: testDb.url, migrationsDir: MIGRATIONS_FOLDER };
    const results = await Promise.all([migrateWithLock(options), migrateWithLock(options)]);

    const applied = results.map((result) => result.after - result.before).sort();
    expect(applied).toEqual([0, MIGRATION_COUNT]);
    expect(await recordedMigrations(testDb.url)).toBe(MIGRATION_COUNT);
  });

  it("waits while another session holds the migration lock", async () => {
    const holder = await connect(testDb.url);
    try {
      await holder.query("select pg_advisory_lock(hashtext($1))", [MIGRATION_LOCK_NAME]);
      const run = migrateWithLock({ databaseUrl: testDb.url, migrationsDir: MIGRATIONS_FOLDER });

      await waitForBlockedAdvisoryLock(holder, testDb.name);
      expect(await recordedMigrations(testDb.url)).toBe(0);

      await holder.query("select pg_advisory_unlock(hashtext($1))", [MIGRATION_LOCK_NAME]);
      await expect(run).resolves.toEqual({ before: 0, after: MIGRATION_COUNT });
    } finally {
      await holder.end();
    }
  });

  it("releases the lock when a migration fails", async () => {
    const holder = await connect(testDb.url);
    try {
      // A table the first migration creates makes it fail part-way.
      await holder.query("create table users (id int)");
      await expect(
        migrateWithLock({ databaseUrl: testDb.url, migrationsDir: MIGRATIONS_FOLDER }),
      ).rejects.toThrow();

      const lock = await holder.query<{ locked: boolean }>(
        "select pg_try_advisory_lock(hashtext($1)) as locked",
        [MIGRATION_LOCK_NAME],
      );
      expect(lock.rows[0]?.locked).toBe(true);
    } finally {
      await holder.end();
    }
  });
});

describe("migration folder", () => {
  const empty = mkdtempSync(join(tmpdir(), "loomcast-migrations-"));

  afterAll(() => {
    rmSync(empty, { recursive: true, force: true });
  });

  it("refuses a folder without a journal", async () => {
    await expect(
      migrateWithLock({
        databaseUrl: "postgres://unused@127.0.0.1:1/unused",
        migrationsDir: empty,
      }),
    ).rejects.toThrow(/MIGRATIONS_DIR/);
  });

  it("prefers MIGRATIONS_DIR and falls back to the checkout's folder", () => {
    expect(resolveMigrationsDir({ MIGRATIONS_DIR: "/app/migrations" })).toBe("/app/migrations");
    expect(resolveMigrationsDir({})).toBe(MIGRATIONS_FOLDER);
    expect(resolveMigrationsDir({ MIGRATIONS_DIR: "" })).toBe(MIGRATIONS_FOLDER);
  });
});
