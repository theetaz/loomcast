import { rmSync } from "node:fs";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../src/migrate";
import { apiTokenChannels, channels, jobs, seriesChannels, workspaces } from "../src/schema";
import { createTestDb, type TestDb } from "../src/testing";
import {
  apiTokenValues,
  insertLegacyContentItem,
  insertLegacySeries,
  insertLegacyWorkspace,
  insertUser,
  PG,
  pgError,
} from "./fixtures";
import { journal, migrateFolder, migrationsUpTo } from "./upgrade";

/** The last migration of the release before projects became workspaces that own channels. */
const PREVIOUS_RELEASE = "0016_add_api_clients";

/** Runs an insert that returns one id. */
async function insertedId(db: TestDb["db"], query: ReturnType<typeof sql>): Promise<string> {
  const result = await db.execute<{ id: string }>(query);
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error("expected a row");
  return id;
}

async function columnsOf(db: TestDb["db"], table: string): Promise<string[]> {
  const result = await db.execute<{ column_name: string }>(
    sql`select column_name from information_schema.columns
        where table_schema = 'public' and table_name = ${table} order by column_name`,
  );
  return result.rows.map((row) => row.column_name);
}

describe("workspace migrations on a database of the previous release", () => {
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

  it("rename projects, move every channel into one workspace and scope the links", async () => {
    const db = testDb.db;
    // Rows as the previous release stores them: projects, `project_id` columns and channels that
    // belong to no project, written in SQL because the current schema names none of them.
    const user = await insertUser(db, { role: "owner" });
    const a = await insertLegacyWorkspace(db, user.id, { slug: "alpha", name: "Alpha" });
    const b = await insertLegacyWorkspace(db, user.id, { slug: "bravo", name: "Bravo" });
    // Takes the slug the orphan Page would derive, so the new workspace gets a suffix.
    const taken = await insertLegacyWorkspace(db, user.id, { slug: "price-lens", name: "Taken" });

    const channel = (platform: string, name: string, parentId: string | null = null) =>
      insertedId(
        db,
        sql`insert into channels (platform, display_name, parent_channel_id)
            values (${platform}, ${name}, ${parentId}) returning id`,
      );
    const publish = async (projectId: string, channelId: string) => {
      const { item, version } = await insertLegacyContentItem(db, { projectId });
      await db.execute(
        sql`insert into scheduled_posts (item_id, version_id, channel_id, scheduled_at, status,
                                         published_at)
            values (${item.id}, ${version.id}, ${channelId}, now(), 'published', now())`,
      );
    };
    const apiClient = (projectId: string) => {
      const token = apiTokenValues({ userId: user.id, kind: "api" });
      return insertedId(
        db,
        sql`insert into api_tokens (user_id, kind, name, token_hash, prefix, project_id)
            values (${user.id}, 'api', ${token.name}, ${token.tokenHash}, ${token.prefix},
                    ${projectId})
            returning id`,
      );
    };

    // A Page that published two items of A and one of B; its Instagram account published only
    // for B, but follows its Page.
    const page = await channel("facebook", "Shared Page");
    await publish(a.id, page);
    await publish(a.id, page);
    await publish(b.id, page);
    const account = await channel("instagram", "Shared Account", page);
    await publish(b.id, account);
    // A channel that only a series of B uses.
    const seriesOfB = await insertLegacySeries(db, b.id, { createdBy: user.id });
    const linked = await channel("threads", "Series Only");
    // A channel that only an API client of A may use.
    const clientOfA = await apiClient(a.id);
    const granted = await channel("x", "Client Only");
    // Links that cross workspaces once the Page is in A: they are removed.
    const clientOfB = await apiClient(b.id);
    await db.execute(
      sql`insert into series_channels (series_id, channel_id)
          values (${seriesOfB.id}, ${linked}), (${seriesOfB.id}, ${page})`,
    );
    await db.execute(
      sql`insert into api_token_channels (token_id, channel_id, access)
          values (${clientOfA}, ${granted}, 'write'), (${clientOfB}, ${page}, 'publish')`,
    );
    // A Page used by nothing, with its Instagram account.
    const orphan = await channel("facebook", "Price Lens!");
    const orphanAccount = await channel("instagram", "Price Lens IG", orphan);
    // A job queued before the rename, naming its project in the payload.
    const job = await insertedId(
      db,
      sql`insert into jobs (type, project_id, payload, created_by)
          values ('system.ping', ${a.id}, ${JSON.stringify({ projectId: a.id })}::jsonb,
                  ${user.id})
          returning id`,
    );

    await migrate(testDb.url);
    await migrate(testDb.url);

    const applied = await db.execute<{ count: number }>(
      sql`select count(*)::int as count from drizzle.__drizzle_migrations`,
    );
    expect(applied.rows[0]?.count).toBe(journal.entries.length);

    // Projects are now workspaces, under the new names only.
    expect(await columnsOf(db, "projects")).toEqual([]);
    expect(await columnsOf(db, "workspaces")).toContain("time_zone");
    const itemColumns = await columnsOf(db, "content_items");
    expect(itemColumns).toContain("workspace_id");
    expect(itemColumns).not.toContain("project_id");
    const leftovers = await db.execute<{ name: string }>(
      sql`select table_name || '.' || column_name as name from information_schema.columns
            where table_schema = 'public' and column_name like '%project%'
          union all select conname from pg_constraint
            where connamespace = 'public'::regnamespace and conname like '%project%'
          union all select indexname from pg_indexes
            where schemaname = 'public' and indexname like '%project%'
          union all select typname from pg_type
            where typnamespace = 'public'::regnamespace and typname like '%project%'`,
    );
    expect(leftovers.rows).toEqual([]);

    // Every channel is in one workspace: by its posts, its series, its API client or its Page.
    const placed = await db
      .select({ id: channels.id, workspaceId: channels.workspaceId })
      .from(channels);
    const workspaceOf = Object.fromEntries(placed.map((row) => [row.id, row.workspaceId]));
    const created = await db.select().from(workspaces).where(eq(workspaces.slug, "price-lens-2"));
    expect(created).toHaveLength(1);
    const [priceLens] = created;
    expect(priceLens).toMatchObject({
      name: "Price Lens!",
      createdBy: user.id,
      status: "active",
      color: "thread",
      timeZone: "UTC",
      icon: null,
    });
    expect(workspaceOf).toEqual({
      [page]: a.id,
      [account]: a.id,
      [linked]: b.id,
      [granted]: a.id,
      [orphan]: priceLens?.id,
      [orphanAccount]: priceLens?.id,
    });
    // Only the orphan Page needed a new workspace; the taken slug kept its owner.
    const all = await db.select({ id: workspaces.id }).from(workspaces);
    expect(all.map((row) => row.id).sort()).toEqual([a.id, b.id, taken.id, priceLens?.id].sort());

    // Links carry their workspace, and those that would cross workspaces are gone.
    expect(
      await db
        .select({
          workspaceId: seriesChannels.workspaceId,
          seriesId: seriesChannels.seriesId,
          channelId: seriesChannels.channelId,
        })
        .from(seriesChannels),
    ).toEqual([{ workspaceId: b.id, seriesId: seriesOfB.id, channelId: linked }]);
    expect(
      await db
        .select({
          workspaceId: apiTokenChannels.workspaceId,
          tokenId: apiTokenChannels.tokenId,
          channelId: apiTokenChannels.channelId,
        })
        .from(apiTokenChannels)
        .where(inArray(apiTokenChannels.tokenId, [clientOfA, clientOfB])),
    ).toEqual([{ workspaceId: a.id, tokenId: clientOfA, channelId: granted }]);

    // A series links only channels of its own workspace from now on.
    expect(
      await pgError(
        db
          .insert(seriesChannels)
          .values({ workspaceId: b.id, seriesId: seriesOfB.id, channelId: page }),
      ),
    ).toEqual({ code: PG.foreignKeyViolation, constraint: "series_channels_channel_fk" });
    expect(
      await pgError(
        db
          .insert(seriesChannels)
          .values({ workspaceId: a.id, seriesId: seriesOfB.id, channelId: page }),
      ),
    ).toEqual({ code: PG.foreignKeyViolation, constraint: "series_channels_series_fk" });

    // The queued job names its workspace under the new key.
    const [kept] = await db.select({ payload: jobs.payload }).from(jobs).where(eq(jobs.id, job));
    expect(kept?.payload).toEqual({ workspaceId: a.id });
  });
});
