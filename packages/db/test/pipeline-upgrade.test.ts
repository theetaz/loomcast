import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate as runMigrations } from "drizzle-orm/node-postgres/migrator";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATIONS_FOLDER, migrate } from "../src/migrate";
import { assets, conversations, kbReferences, series } from "../src/schema";
import { createTestDb, type TestDb } from "../src/testing";
import { assetValues, insertContentItem, insertFormat } from "./fixtures";

/** The last migration of the release before the pipeline tables. */
const PREVIOUS_RELEASE = "0004_add_pipeline_job_types";

interface Journal {
  entries: { tag: string }[];
}

const journal = JSON.parse(
  readFileSync(join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8"),
) as Journal;

/** A copy of the migrations folder that ends at `lastTag`. */
function migrationsUpTo(lastTag: string): string {
  const end = journal.entries.findIndex((entry) => entry.tag === lastTag);
  if (end < 0) throw new Error(`the journal has no ${lastTag}`);
  const entries = journal.entries.slice(0, end + 1);
  const folder = mkdtempSync(join(tmpdir(), "loomcast-previous-migrations-"));
  mkdirSync(join(folder, "meta"));
  for (const entry of entries) {
    copyFileSync(join(MIGRATIONS_FOLDER, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
  }
  writeFileSync(join(folder, "meta", "_journal.json"), JSON.stringify({ ...journal, entries }));
  return folder;
}

async function one<T extends Record<string, unknown>>(
  db: TestDb["db"],
  query: ReturnType<typeof sql>,
) {
  const result = await db.execute<T>(query);
  const [row] = result.rows;
  if (row === undefined) throw new Error("expected a row");
  return row;
}

describe("pipeline migrations on a database of the previous release", () => {
  let testDb: TestDb;
  let folder: string;

  beforeAll(async () => {
    testDb = await createTestDb({ empty: true });
    folder = migrationsUpTo(PREVIOUS_RELEASE);
    const client = new Client({ connectionString: testDb.url });
    await client.connect();
    try {
      await runMigrations(drizzle({ client }), { migrationsFolder: folder });
    } finally {
      await client.end();
    }
  });

  afterAll(async () => {
    await testDb.drop();
    rmSync(folder, { recursive: true, force: true });
  });

  it("keep existing rows and leave the new links empty", async () => {
    const db = testDb.db;
    // Rows in the previous release's shape: the current schema names columns that do not exist
    // yet, so they are written as SQL.
    const user = await one<{ id: string }>(
      db,
      sql`insert into users (email, name, role) values ('upgrade@example.com', 'Upgrade', 'owner')
          returning id`,
    );
    const project = await one<{ id: string }>(
      db,
      sql`insert into projects (slug, name, created_by) values ('upgrade', 'Upgrade', ${user.id})
          returning id`,
    );
    const conversation = await one<{ id: string }>(
      db,
      sql`insert into conversations (project_id, created_by) values (${project.id}, ${user.id})
          returning id`,
    );
    const job = await one<{ id: string }>(
      db,
      sql`insert into jobs (type, project_id, payload, created_by)
          values ('content.render', ${project.id}, '{}', ${user.id}) returning id`,
    );
    const entry = await one<{ id: string }>(
      db,
      sql`insert into kb_entries (project_id, kind, title, created_via)
          values (${project.id}, 'reference', 'A reference', 'ui') returning id`,
    );
    await db.execute(
      sql`insert into kb_references (entry_id, url, platform, transcript)
          values (${entry.id}, 'https://example.com/v/3', 'other', 'Words')`,
    );

    await migrate(testDb.url);
    await migrate(testDb.url);

    const applied = await one<{ count: number }>(
      db,
      sql`select count(*)::int as count from drizzle.__drizzle_migrations`,
    );
    expect(applied.count).toBe(journal.entries.length);

    const [linked] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversation.id));
    expect(linked?.contentItemId).toBeNull();
    const [reference] = await db
      .select()
      .from(kbReferences)
      .where(eq(kbReferences.entryId, entry.id));
    expect(reference).toMatchObject({ transcript: "Words", mediaAssetId: null });
    const jobRow = await one<{ type: string }>(
      db,
      sql`select type::text as type from jobs where id = ${job.id}`,
    );
    expect(jobRow.type).toBe("content.render");

    // The upgraded database takes the pipeline rows.
    const { format } = await insertFormat(db, project.id, user.id);
    const [created] = await db
      .insert(series)
      .values({ projectId: project.id, name: "Upgraded", slug: "upgraded", formatId: format.id })
      .returning();
    const { item } = await insertContentItem(db, {
      projectId: project.id,
      seriesId: created?.id,
      createdBy: user.id,
    });
    await db
      .update(conversations)
      .set({ contentItemId: item.id })
      .where(eq(conversations.id, conversation.id));
    const [media] = await db
      .insert(assets)
      .values(
        assetValues({
          projectId: project.id,
          kind: "reference_media",
          mime: "video/mp4",
          createdByJob: job.id,
        }),
      )
      .returning();
    await db
      .update(kbReferences)
      .set({ mediaAssetId: media?.id })
      .where(eq(kbReferences.entryId, entry.id));
  });
});
