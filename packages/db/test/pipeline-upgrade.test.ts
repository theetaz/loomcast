import { rmSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../src/migrate";
import { assets, conversations, kbReferences, series } from "../src/schema";
import { createTestDb, type TestDb } from "../src/testing";
import { assetValues, insertContentItem, insertFormat } from "./fixtures";
import { journal, migrateFolder, migrationsUpTo } from "./upgrade";

/** The last migration of the release before the pipeline tables. */
const PREVIOUS_RELEASE = "0004_add_pipeline_job_types";

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
    await migrateFolder(testDb.url, folder);
  });

  afterAll(async () => {
    await testDb.drop();
    rmSync(folder, { recursive: true, force: true });
  });

  it("keep existing rows and leave the new links empty", async () => {
    const db = testDb.db;
    // Rows in the previous release's shape: the current schema names tables and columns that do
    // not exist yet (and `workspaces` was still `projects`), so they are written as SQL.
    const user = await one<{ id: string }>(
      db,
      sql`insert into users (email, name, role) values ('upgrade@example.com', 'Upgrade', 'owner')
          returning id`,
    );
    const workspace = await one<{ id: string }>(
      db,
      sql`insert into projects (slug, name, created_by) values ('upgrade', 'Upgrade', ${user.id})
          returning id`,
    );
    const conversation = await one<{ id: string }>(
      db,
      sql`insert into conversations (project_id, created_by) values (${workspace.id}, ${user.id})
          returning id`,
    );
    const job = await one<{ id: string }>(
      db,
      sql`insert into jobs (type, project_id, payload, created_by)
          values ('content.render', ${workspace.id}, '{}', ${user.id}) returning id`,
    );
    const entry = await one<{ id: string }>(
      db,
      sql`insert into kb_entries (project_id, kind, title, created_via)
          values (${workspace.id}, 'reference', 'A reference', 'ui') returning id`,
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
    const { format } = await insertFormat(db, workspace.id, user.id);
    const [created] = await db
      .insert(series)
      .values({
        workspaceId: workspace.id,
        name: "Upgraded",
        slug: "upgraded",
        formatId: format.id,
      })
      .returning();
    const { item } = await insertContentItem(db, {
      workspaceId: workspace.id,
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
          workspaceId: workspace.id,
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
