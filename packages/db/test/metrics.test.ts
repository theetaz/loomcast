import { aggregatePosts, PostMetricsSchema } from "@loomcast/contracts";
import { desc, eq, type SQL, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { latestPostMetrics } from "../src/queries/metrics";
import { type NewPostMetricsRow, postMetrics, scheduledPosts } from "../src/schema";
import { createTestDb, type TestDb } from "../src/testing";
import {
  insertActiveChannel,
  insertContentItem,
  insertPost,
  insertUser,
  insertWorkspace,
  PG,
  pgError,
} from "./fixtures";

let testDb: TestDb;

beforeAll(async () => {
  testDb = await createTestDb();
});

afterAll(async () => {
  await testDb.drop();
});

const HOUR_MS = 60 * 60_000;
const PUBLISHED_AT = new Date(Date.UTC(2026, 9, 1, 9));

function hoursAfterPublish(hours: number): Date {
  return new Date(PUBLISHED_AT.getTime() + hours * HOUR_MS);
}

async function insertPublishedPost() {
  const user = await insertUser(testDb.db);
  const workspace = await insertWorkspace(testDb.db, user.id);
  const { item, version } = await insertContentItem(testDb.db, {
    workspaceId: workspace.id,
    createdBy: user.id,
  });
  const channel = await insertActiveChannel(testDb.db, {
    workspaceId: workspace.id,
    platform: "instagram",
  });
  return insertPost(testDb.db, {
    itemId: item.id,
    channelId: channel.id,
    versionId: version.id,
    status: "published",
    publishedAt: PUBLISHED_AT,
  });
}

type CaptureFixture = Omit<NewPostMetricsRow, "postId">;

async function capture(postId: string, values: CaptureFixture) {
  const [row] = await testDb.db
    .insert(postMetrics)
    .values({ postId, ...values })
    .returning();
  if (row === undefined) throw new Error("metrics were not inserted");
  return row;
}

/** The plan Postgres picks for `query` when it may not scan whole tables. */
async function planWithoutSeqScan(query: SQL): Promise<string> {
  return testDb.db.transaction(async (tx) => {
    await tx.execute(sql`set local enable_seqscan = off`);
    const result = await tx.execute<{ "QUERY PLAN": string }>(sql`explain ${query}`);
    return result.rows.map((row) => row["QUERY PLAN"]).join("\n");
  });
}

describe("post_metrics", () => {
  it("keep captures with nullable counts, readable as the contracts shape", async () => {
    const post = await insertPublishedPost();
    const row = await capture(post.id, {
      capturedAt: hoursAfterPublish(1),
      views: 3_000_000_000,
      likes: 12,
      comments: 0,
      shares: null,
      saves: null,
      reach: 900,
      avgWatchMs: 4_200,
      raw: { data: [{ name: "views", values: [{ value: 3_000_000_000 }] }] },
    });

    expect(row).toMatchObject({
      views: 3_000_000_000,
      shares: null,
      saves: null,
      avgWatchMs: 4_200,
    });
    expect(typeof row.id).toBe("number");
    const metrics = PostMetricsSchema.parse({ ...row, capturedAt: row.capturedAt.toISOString() });
    expect(metrics).toEqual({
      capturedAt: hoursAfterPublish(1).toISOString(),
      views: 3_000_000_000,
      likes: 12,
      comments: 0,
      shares: null,
      saves: null,
      reach: 900,
      avgWatchMs: 4_200,
    });

    const bare = await capture(post.id, {});
    expect(bare).toMatchObject({ views: null, reach: null, avgWatchMs: null, raw: {} });
    expect(bare.capturedAt).toBeInstanceOf(Date);
  });

  it("refuse negative counts and a raw answer that is not an object", async () => {
    const post = await insertPublishedPost();
    for (const values of [{ views: -1 }, { saves: -1 }, { avgWatchMs: -1 }]) {
      expect(await pgError(capture(post.id, values))).toEqual({
        code: PG.checkViolation,
        constraint: "post_metrics_counts_ck",
      });
    }
    expect(
      await pgError(
        testDb.db.execute(
          sql`insert into post_metrics (post_id, raw) values (${post.id}, '[]'::jsonb)`,
        ),
      ),
    ).toEqual({ code: PG.checkViolation, constraint: "post_metrics_raw_ck" });
  });

  it("list a post's history newest first through the (post_id, captured_at desc) index", async () => {
    const post = await insertPublishedPost();
    const other = await insertPublishedPost();
    // Inserted out of order, as retried pulls may land.
    for (const hours of [24, 1, 168, 6, 72]) {
      await capture(post.id, { capturedAt: hoursAfterPublish(hours), views: hours * 10 });
    }
    await capture(other.id, { capturedAt: hoursAfterPublish(500), views: 1 });

    const history = await testDb.db
      .select({ capturedAt: postMetrics.capturedAt, views: postMetrics.views })
      .from(postMetrics)
      .where(eq(postMetrics.postId, post.id))
      .orderBy(desc(postMetrics.capturedAt));
    expect(history.map((row) => row.views)).toEqual([1680, 720, 240, 60, 10]);

    const plan = await planWithoutSeqScan(
      sql`select * from post_metrics where post_id = ${post.id} order by captured_at desc limit 1`,
    );
    expect(plan).toContain("post_metrics_post_id_captured_at_idx");
    expect(plan).not.toContain("Sort");
  });

  it("give the latest capture of each post, for the aggregates", async () => {
    const first = await insertPublishedPost();
    const second = await insertPublishedPost();
    const unmeasured = await insertPublishedPost();
    await capture(first.id, { capturedAt: hoursAfterPublish(24), views: 200, likes: 20 });
    await capture(first.id, { capturedAt: hoursAfterPublish(1), views: 50, likes: 5 });
    await capture(second.id, { capturedAt: hoursAfterPublish(6), views: 100, likes: 1 });
    // Same capture time: the row inserted last wins.
    await capture(second.id, { capturedAt: hoursAfterPublish(6), views: 120, likes: 2 });

    const latest = await latestPostMetrics(testDb.db, [first.id, second.id, unmeasured.id]);
    const byPost = new Map(latest.map((row) => [row.postId, row]));
    expect(latest).toHaveLength(2);
    expect(byPost.get(first.id)).toMatchObject({ views: 200, likes: 20 });
    expect(byPost.get(second.id)).toMatchObject({ views: 120, likes: 2 });
    expect(await latestPostMetrics(testDb.db, [])).toEqual([]);

    const aggregate = aggregatePosts(
      [first, second, unmeasured].map((post) => byPost.get(post.id) ?? null),
    );
    expect(aggregate).toMatchObject({ posts: 3, measuredPosts: 2, views: 320, likes: 22 });
  });

  it("go with their post", async () => {
    const post = await insertPublishedPost();
    await capture(post.id, { views: 1 });

    await testDb.db.delete(scheduledPosts).where(eq(scheduledPosts.id, post.id));

    expect(
      await testDb.db.select().from(postMetrics).where(eq(postMetrics.postId, post.id)),
    ).toEqual([]);
  });
});
