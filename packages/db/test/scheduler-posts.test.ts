import { effectivePublishMode, type PublishError } from "@loomcast/contracts";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  channels,
  contentItems,
  formatVersions,
  publishAttempts,
  scheduledPosts,
  series,
} from "../src/schema";
import { createTestDb, type TestDb } from "../src/testing";
import {
  insertActiveChannel,
  insertChannel,
  insertContentItem,
  insertPost,
  insertProject,
  insertSeries,
  insertUser,
  PG,
  pgError,
  postValues,
} from "./fixtures";

let testDb: TestDb;

beforeAll(async () => {
  testDb = await createTestDb();
});

afterAll(async () => {
  await testDb.drop();
});

async function setup() {
  const user = await insertUser(testDb.db);
  const project = await insertProject(testDb.db, user.id);
  const created = await insertSeries(testDb.db, project.id, user.id);
  const { item, version } = await insertContentItem(testDb.db, {
    projectId: project.id,
    seriesId: created.id,
    createdBy: user.id,
  });
  const channel = await insertChannel(testDb.db);
  return { user, project, series: created, item, version, channel };
}

describe("scheduled_posts", () => {
  it("start planned, in dry-run, with no version and no attempts", async () => {
    const { item, channel, series } = await setup();
    const post = await insertPost(testDb.db, {
      itemId: item.id,
      channelId: channel.id,
      seriesId: series.id,
    });

    expect(post).toMatchObject({
      status: "planned",
      dryRun: true,
      versionId: null,
      attempts: 0,
      lastError: null,
      permalink: null,
      publishedAt: null,
    });
  });

  it("allow one open post per item and channel", async () => {
    const { item, channel } = await setup();
    const other = await insertChannel(testDb.db, { platform: "threads" });
    const first = await insertPost(testDb.db, { itemId: item.id, channelId: channel.id });
    await insertPost(testDb.db, { itemId: item.id, channelId: other.id });

    for (const status of ["planned", "missed", "failed"] as const) {
      await testDb.db.update(scheduledPosts).set({ status }).where(eq(scheduledPosts.id, first.id));
      expect(
        await pgError(
          testDb.db
            .insert(scheduledPosts)
            .values(postValues({ itemId: item.id, channelId: channel.id })),
        ),
      ).toEqual({ code: PG.uniqueViolation, constraint: "scheduled_posts_item_id_channel_id_uq" });
    }

    // A cancelled post frees the slot; any number of cancelled posts may stay.
    await testDb.db
      .update(scheduledPosts)
      .set({ status: "cancelled" })
      .where(eq(scheduledPosts.id, first.id));
    const second = await insertPost(testDb.db, { itemId: item.id, channelId: channel.id });
    await testDb.db
      .update(scheduledPosts)
      .set({ status: "cancelled" })
      .where(eq(scheduledPosts.id, second.id));
    await insertPost(testDb.db, { itemId: item.id, channelId: channel.id });
  });

  it("insert-or-skip on the open post with the predicate as the conflict target", async () => {
    const { item, channel } = await setup();
    const values = postValues({ itemId: item.id, channelId: channel.id });
    const insert = () =>
      testDb.db
        .insert(scheduledPosts)
        .values(values)
        .onConflictDoNothing({
          target: [scheduledPosts.itemId, scheduledPosts.channelId],
          where: sql`status <> 'cancelled'`,
        })
        .returning();

    expect(await insert()).toHaveLength(1);
    expect(await insert()).toEqual([]);
  });

  it("require a version of the same item once queued, publishing or published", async () => {
    const { item, version, channel } = await setup();
    const other = await setup();
    const post = await insertPost(testDb.db, { itemId: item.id, channelId: channel.id });

    for (const status of ["queued", "publishing"] as const) {
      expect(
        await pgError(
          testDb.db.update(scheduledPosts).set({ status }).where(eq(scheduledPosts.id, post.id)),
        ),
      ).toEqual({ code: PG.checkViolation, constraint: "scheduled_posts_version_ck" });
    }
    expect(
      await pgError(
        testDb.db
          .update(scheduledPosts)
          .set({ status: "queued", versionId: other.version.id })
          .where(eq(scheduledPosts.id, post.id)),
      ),
    ).toEqual({ code: PG.foreignKeyViolation, constraint: "scheduled_posts_version_fk" });

    const [queued] = await testDb.db
      .update(scheduledPosts)
      .set({ status: "queued", versionId: version.id })
      .where(eq(scheduledPosts.id, post.id))
      .returning();
    expect(queued?.versionId).toBe(version.id);

    // Leaving `approved` clears the version again.
    await testDb.db
      .update(scheduledPosts)
      .set({ status: "planned", versionId: null })
      .where(eq(scheduledPosts.id, post.id));
  });

  it("require published_at once published", async () => {
    const { item, version, channel } = await setup();
    const post = await insertPost(testDb.db, {
      itemId: item.id,
      channelId: channel.id,
      status: "publishing",
      versionId: version.id,
    });

    expect(
      await pgError(
        testDb.db
          .update(scheduledPosts)
          .set({ status: "published" })
          .where(eq(scheduledPosts.id, post.id)),
      ),
    ).toEqual({ code: PG.checkViolation, constraint: "scheduled_posts_published_at_ck" });

    const lastError: PublishError = { code: "transient", retryable: true, message: "Timed out" };
    const [published] = await testDb.db
      .update(scheduledPosts)
      .set({
        status: "published",
        publishedAt: new Date(),
        permalink: `dryrun://instagram/${post.id}`,
        attempts: 2,
        lastError,
      })
      .where(eq(scheduledPosts.id, post.id))
      .returning();
    expect(published).toMatchObject({ status: "published", attempts: 2, lastError });
  });

  it("keep posts of a channel, which cannot be deleted while it has any", async () => {
    const { item, channel } = await setup();
    await insertPost(testDb.db, { itemId: item.id, channelId: channel.id });

    expect(await pgError(testDb.db.delete(channels).where(eq(channels.id, channel.id)))).toEqual({
      code: PG.foreignKeyViolation,
      constraint: "scheduled_posts_channel_id_channels_id_fk",
    });
  });

  it("go away with their item, with their attempts, and outlive their series", async () => {
    const { item, version, channel, series: created } = await setup();
    const post = await insertPost(testDb.db, {
      itemId: item.id,
      channelId: channel.id,
      seriesId: created.id,
      status: "queued",
      versionId: version.id,
    });
    await testDb.db
      .insert(publishAttempts)
      .values({ postId: post.id, attempt: 1, adapter: "instagram", dryRun: true });

    await testDb.db.delete(series).where(eq(series.id, created.id));
    const [kept] = await testDb.db
      .select()
      .from(scheduledPosts)
      .where(eq(scheduledPosts.id, post.id));
    expect(kept?.seriesId).toBeNull();

    await testDb.db.delete(contentItems).where(eq(contentItems.id, item.id));
    expect(
      await testDb.db.select().from(scheduledPosts).where(eq(scheduledPosts.id, post.id)),
    ).toEqual([]);
    expect(
      await testDb.db.select().from(publishAttempts).where(eq(publishAttempts.postId, post.id)),
    ).toEqual([]);
  });

  it("join to the project, platform and effective publish mode of the contracts shape", async () => {
    const { project, item, series: created } = await setup();
    const channel = await insertActiveChannel(testDb.db, {
      platform: "facebook",
      requiresApproval: true,
    });
    const post = await insertPost(testDb.db, {
      itemId: item.id,
      channelId: channel.id,
      seriesId: created.id,
    });

    const [row] = await testDb.db
      .select({
        id: scheduledPosts.id,
        projectId: contentItems.projectId,
        platform: channels.platform,
        requiresApproval: channels.requiresApproval,
        formatMode: sql<"auto" | "approval">`${formatVersions.rules}->>'publishMode'`,
        title: contentItems.title,
      })
      .from(scheduledPosts)
      .innerJoin(contentItems, eq(contentItems.id, scheduledPosts.itemId))
      .innerJoin(channels, eq(channels.id, scheduledPosts.channelId))
      .leftJoin(series, eq(series.id, scheduledPosts.seriesId))
      .leftJoin(
        formatVersions,
        and(
          eq(formatVersions.formatId, series.formatId),
          sql`${formatVersions.id} = (select current_version_id from formats where id = ${series.formatId})`,
        ),
      )
      .where(eq(scheduledPosts.id, post.id));

    expect(row).toMatchObject({
      projectId: project.id,
      platform: "facebook",
      formatMode: "approval",
    });
    if (row === undefined) throw new Error("expected the post");
    expect(effectivePublishMode(row.formatMode, row.requiresApproval)).toBe("approval");
  });
});

describe("publish_attempts", () => {
  it("number attempts from 1, once per post", async () => {
    const { item, version, channel } = await setup();
    const post = await insertPost(testDb.db, {
      itemId: item.id,
      channelId: channel.id,
      status: "queued",
      versionId: version.id,
    });
    const request = { platform: "instagram", caption: "Hello" };

    const [attempt] = await testDb.db
      .insert(publishAttempts)
      .values({ postId: post.id, attempt: 1, adapter: "instagram", dryRun: true, request })
      .returning();
    expect(attempt).toMatchObject({ attempt: 1, request, response: null, finishedAt: null });
    expect(attempt?.startedAt).toBeInstanceOf(Date);

    expect(
      await pgError(
        testDb.db
          .insert(publishAttempts)
          .values({ postId: post.id, attempt: 1, adapter: "instagram", dryRun: true }),
      ),
    ).toEqual({ code: PG.uniqueViolation, constraint: "publish_attempts_post_id_attempt_uq" });
    expect(
      await pgError(
        testDb.db
          .insert(publishAttempts)
          .values({ postId: post.id, attempt: 0, adapter: "instagram", dryRun: true }),
      ),
    ).toEqual({ code: PG.checkViolation, constraint: "publish_attempts_attempt_ck" });
  });
});
