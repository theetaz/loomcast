import { rmSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../src/migrate";
import { assets } from "../src/schema";
import { createTestDb, type TestDb } from "../src/testing";
import {
  assetValues,
  insertLegacyAsset,
  insertLegacyContentItem,
  insertLegacyWorkspace,
  insertUser,
  PG,
  pgError,
  randomHash,
} from "./fixtures";
import { journal, migrateFolder, migrationsUpTo } from "./upgrade";

/** The last migration of the release that deduplicated every asset per workspace. */
const PREVIOUS_RELEASE = "0012_add_post_metrics";

async function dedupeIndexes(testDb: TestDb): Promise<Record<string, string>> {
  const result = await testDb.db.execute<{ indexname: string; indexdef: string }>(
    sql`select indexname, indexdef from pg_indexes
        where tablename = 'assets' and indexname like '%sha256_uq' order by indexname`,
  );
  return Object.fromEntries(result.rows.map((row) => [row.indexname, row.indexdef]));
}

describe("asset dedupe migration on a database of the previous release", () => {
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

  it("keeps existing assets and lets two items hold the same bytes", async () => {
    const db = testDb.db;
    // Assets as the previous release stores them, under the old names (`projects`, `project_id`).
    const user = await insertUser(db);
    const project = await insertLegacyWorkspace(db, user.id);
    const { item: first } = await insertLegacyContentItem(db, { projectId: project.id });
    const { item: second } = await insertLegacyContentItem(db, { projectId: project.id });
    const sha256 = randomHash();
    const voice = { kind: "voice", sha256, status: "ready" } as const;
    const reference = {
      kind: "reference_media",
      mime: "video/mp4",
      sha256,
      status: "ready",
    } as const;
    const kept: { id: string }[] = [];
    for (const values of [
      { ...voice, itemId: first.id },
      reference,
      { ...voice, itemId: second.id, status: "failed" as const },
    ]) {
      const result = await insertLegacyAsset(db, project.id, values);
      kept.push(...result.rows);
    }

    // The previous release refuses the second item's own copy.
    const before = await pgError(
      insertLegacyAsset(db, project.id, { ...voice, itemId: second.id }),
    );
    expect(before).toEqual({
      code: PG.uniqueViolation,
      constraint: "assets_project_id_kind_sha256_uq",
    });

    await migrate(testDb.url);
    await migrate(testDb.url);

    const applied = await db.execute<{ count: number }>(
      sql`select count(*)::int as count from drizzle.__drizzle_migrations`,
    );
    expect(applied.rows[0]?.count).toBe(journal.entries.length);
    const indexes = await dedupeIndexes(testDb);
    expect(Object.keys(indexes)).toEqual([
      "assets_workspace_id_item_id_kind_sha256_uq",
      "assets_workspace_id_kind_sha256_uq",
    ]);
    expect(indexes.assets_workspace_id_item_id_kind_sha256_uq).toContain(
      "WHERE ((item_id IS NOT NULL) AND (status <> 'failed'::asset_status))",
    );
    expect(indexes.assets_workspace_id_kind_sha256_uq).toContain(
      "WHERE ((item_id IS NULL) AND (status <> 'failed'::asset_status))",
    );

    // The assets are kept and belong to the workspace the project became.
    for (const { id } of kept) {
      expect(
        await db
          .select({ id: assets.id, workspaceId: assets.workspaceId })
          .from(assets)
          .where(eq(assets.id, id)),
      ).toEqual([{ id, workspaceId: project.id }]);
    }

    // The second item now holds its own copy, the first item still deduplicates, and workspace-level
    // media still deduplicates per workspace.
    const [copy] = await db
      .insert(assets)
      .values(assetValues({ ...voice, workspaceId: project.id, itemId: second.id }))
      .returning();
    expect(copy?.itemId).toBe(second.id);
    expect(
      await pgError(
        db
          .insert(assets)
          .values(assetValues({ ...voice, workspaceId: project.id, itemId: first.id })),
      ),
    ).toEqual({
      code: PG.uniqueViolation,
      constraint: "assets_workspace_id_item_id_kind_sha256_uq",
    });
    expect(
      await pgError(
        db.insert(assets).values(assetValues({ ...reference, workspaceId: project.id })),
      ),
    ).toEqual({
      code: PG.uniqueViolation,
      constraint: "assets_workspace_id_kind_sha256_uq",
    });
  });
});
