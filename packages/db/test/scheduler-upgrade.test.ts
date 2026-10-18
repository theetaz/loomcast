import { rmSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../src/migrate";
import { claimDueTasks, enqueueTask } from "../src/queries/scheduler";
import { contentItems, publishAttempts, series, seriesChannels } from "../src/schema";
import { createTestDb, type TestDb } from "../src/testing";
import {
  insertActiveChannel,
  insertFormat,
  insertLegacyContentItem,
  insertPost,
  insertProject,
  insertUser,
} from "./fixtures";
import { journal, migrateFolder, migrationsUpTo } from "./upgrade";

/** The last migration of the release before channels and the scheduler. */
const PREVIOUS_RELEASE = "0007_add_assets_and_skills";

const NEW_TABLES = [
  "channels",
  "publish_attempts",
  "scheduled_posts",
  "scheduled_tasks",
  "series_channels",
];
const newTables = sql.join(
  NEW_TABLES.map((name) => sql`${name}`),
  sql`, `,
);

describe("scheduler migrations on a database of the previous release", () => {
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

  it("apply in one batch, keep existing rows and take scheduler rows", async () => {
    const db = testDb.db;
    // Pipeline rows as the previous release stores them; these tables are unchanged since.
    const user = await insertUser(db, { role: "owner" });
    const project = await insertProject(db, user.id);
    const { format } = await insertFormat(db, project.id, user.id);
    const [created] = await db
      .insert(series)
      .values({ projectId: project.id, name: "Upgraded", slug: "upgraded", formatId: format.id })
      .returning();
    if (created === undefined) throw new Error("series was not inserted");
    const { item, version } = await insertLegacyContentItem(db, {
      projectId: project.id,
      seriesId: created.id,
      createdBy: user.id,
      targetAt: new Date(Date.UTC(2026, 11, 1, 9)),
    });
    const before = await db.execute<{ table_name: string }>(
      sql`select table_name from information_schema.tables
          where table_schema = 'public' and table_name in (${newTables})`,
    );
    expect(before.rows).toEqual([]);

    await migrate(testDb.url);
    await migrate(testDb.url);

    const applied = await db.execute<{ count: number }>(
      sql`select count(*)::int as count from drizzle.__drizzle_migrations`,
    );
    expect(applied.rows[0]?.count).toBe(journal.entries.length);
    const after = await db.execute<{ table_name: string }>(
      sql`select table_name from information_schema.tables
          where table_schema = 'public' and table_name in (${newTables})
          order by table_name`,
    );
    expect(after.rows.map((row) => row.table_name)).toEqual(NEW_TABLES);

    // Existing rows are untouched.
    const [kept] = await db.select().from(contentItems).where(eq(contentItems.id, item.id));
    expect(kept).toMatchObject({
      seriesId: created.id,
      currentVersionId: version.id,
      targetAt: new Date(Date.UTC(2026, 11, 1, 9)),
    });

    // The upgraded database takes channels, links, posts, attempts and tasks.
    const page = await insertActiveChannel(db, { platform: "facebook", createdBy: user.id });
    const account = await insertActiveChannel(db, {
      platform: "instagram",
      parentChannelId: page.id,
    });
    await db.insert(seriesChannels).values([
      { seriesId: created.id, channelId: page.id },
      { seriesId: created.id, channelId: account.id, enabled: false },
    ]);
    const post = await insertPost(db, {
      itemId: item.id,
      channelId: page.id,
      seriesId: created.id,
      status: "queued",
      versionId: version.id,
    });
    await db
      .insert(publishAttempts)
      .values({ postId: post.id, attempt: 1, adapter: "facebook", dryRun: true });
    const runAt = new Date(Date.UTC(2026, 11, 1, 9));
    const { task } = await enqueueTask(db, {
      kind: "post.publish",
      payload: { postId: post.id },
      runAt,
      maxAttempts: 5,
      dedupeKey: `publish:${post.id}`,
    });
    const { claimed } = await claimDueTasks(db, {
      limit: 10,
      workerId: "upgrade",
      leaseMs: 60_000,
      now: runAt,
    });
    expect(claimed.map((row) => row.id)).toEqual([task.id]);
  });
});
