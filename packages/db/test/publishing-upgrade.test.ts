import { rmSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../src/migrate";
import { latestPostMetrics } from "../src/queries/metrics";
import { consumeOAuthConnection, consumeOAuthState } from "../src/queries/oauth";
import { channels, postMetrics } from "../src/schema";
import { createTestDb, type TestDb } from "../src/testing";
import {
  insertActiveChannel,
  insertContentItem,
  insertOAuthConnection,
  insertOAuthState,
  insertPost,
  insertProject,
  insertUser,
  oauthState,
  sealedPkce,
  sealedSecret,
} from "./fixtures";
import { journal, migrateFolder, migrationsUpTo } from "./upgrade";

/** The last migration of the release before OAuth connections and post metrics. */
const PREVIOUS_RELEASE = "0010_add_scheduled_tasks";

const NEW_TABLES = ["oauth_connections", "oauth_states", "post_metrics"];
const newTables = sql.join(
  NEW_TABLES.map((name) => sql`${name}`),
  sql`, `,
);

describe("publishing migrations on a database of the previous release", () => {
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

  it("apply twice in one batch, keep channels and posts, and take the new rows", async () => {
    const db = testDb.db;
    // Rows as the previous release stores them, written in SQL because the current schema names
    // channel columns that do not exist yet.
    const user = await insertUser(db, { role: "owner" });
    const project = await insertProject(db, user.id);
    const { item, version } = await insertContentItem(db, {
      projectId: project.id,
      createdBy: user.id,
    });
    const secret = sealedSecret();
    const page = await db.execute<{ id: string }>(sql`
      insert into channels (platform, display_name, external_id, status, secret_ciphertext,
                            secret_nonce, key_version)
      values ('facebook', 'Upgraded Page', 'page-1', 'active',
              ${secret.secretCiphertext}, ${secret.secretNonce}, 1)
      returning id`);
    const pageId = page.rows[0]?.id;
    if (pageId === undefined) throw new Error("channel was not inserted");
    const post = await insertPost(db, {
      itemId: item.id,
      channelId: pageId,
      versionId: version.id,
      status: "published",
      publishedAt: new Date(Date.UTC(2026, 9, 1, 9)),
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

    // The existing channel keeps its credentials and has no health record yet.
    const [kept] = await db.select().from(channels).where(eq(channels.id, pageId));
    expect(kept).toMatchObject({
      status: "active",
      externalId: "page-1",
      keyVersion: 1,
      lastVerifiedAt: null,
      lastError: null,
      rateLimit: null,
    });
    expect(kept?.secretCiphertext).not.toBeNull();

    // The upgraded database takes sign-ins, pending connections, metrics and channel health.
    const { hash } = oauthState();
    await insertOAuthState(db, { userId: user.id, stateHash: hash, ...sealedPkce() });
    const state = await consumeOAuthState(db, {
      stateHash: hash,
      provider: "meta",
      userId: user.id,
    });
    expect(state?.pkceCiphertext).not.toBeNull();
    const connection = await insertOAuthConnection(db, { userId: user.id });
    expect(await consumeOAuthConnection(db, { id: connection.id, userId: user.id })).not.toBeNull();
    await db.insert(postMetrics).values({ postId: post.id, views: 10, raw: { views: 10 } });
    expect(await latestPostMetrics(db, [post.id])).toMatchObject([{ postId: post.id, views: 10 }]);
    const account = await insertActiveChannel(db, {
      platform: "instagram",
      parentChannelId: pageId,
    });
    await db
      .update(channels)
      .set({ lastVerifiedAt: new Date(), rateLimit: { call_count: 1 } })
      .where(eq(channels.id, account.id));
  });
});
