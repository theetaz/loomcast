import { randomUUID } from "node:crypto";
import { DEFAULT_FORMAT_RULES } from "@loomcast/contracts";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "../src/client";
import { nextFormatVersionNo, nextSkillVersion, nextVersionNo } from "../src/queries/versions";
import {
  type AssetMeta,
  assets,
  contentItems,
  contentVersions,
  conversations,
  formats,
  formatVersions,
  kbReferences,
  reviews,
  series,
  skills,
  skillVersions,
} from "../src/schema";
import { createTestDb, type TestDb } from "../src/testing";
import {
  assetValues,
  insertContentItem,
  insertConversation,
  insertFormat,
  insertItemWith,
  insertJob,
  insertKbEntry,
  insertProject,
  insertSkill,
  insertUser,
  PG,
  pgError,
  randomHash,
  skillFiles,
} from "./fixtures";

let testDb: TestDb;

beforeAll(async () => {
  // Enough connections for the concurrent writers plus the observer.
  testDb = await createTestDb({ max: 12 });
});

afterAll(async () => {
  await testDb.drop();
});

async function setup() {
  const user = await insertUser(testDb.db);
  const project = await insertProject(testDb.db, user.id);
  return { user, project };
}

/** Appends a version on top of the item's current one, as a job result or an edit would. */
async function appendVersion(db: Database, itemId: string, jobId?: string) {
  return db.transaction(async (tx) => {
    const versionNo = await nextVersionNo(tx, itemId);
    if (versionNo === null) throw new Error("item not found");
    const [item] = await tx.select().from(contentItems).where(eq(contentItems.id, itemId));
    const [version] = await tx
      .insert(contentVersions)
      .values({
        itemId,
        versionNo,
        stage: "script",
        parentVersionId: item?.currentVersionId,
        createdVia: jobId === undefined ? "ui" : "job",
        jobId,
      })
      .returning();
    if (version === undefined) throw new Error("version was not inserted");
    await tx
      .update(contentItems)
      .set({ currentVersionId: version.id, state: "script" })
      .where(eq(contentItems.id, itemId));
    return version;
  });
}

/** Resolves once `count` backends of this test database wait on a lock. */
async function lockWaiters(count: number): Promise<void> {
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    const result = await testDb.db.execute<{ waiting: number }>(
      sql`select count(*)::int as waiting from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock'`,
    );
    if ((result.rows[0]?.waiting ?? 0) >= count) return;
  }
  throw new Error(`expected ${count} backends to wait on a lock`);
}

describe("formats and series", () => {
  it("insert a format and its first version in one transaction", async () => {
    const { user, project } = await setup();
    const { format, version } = await insertFormat(testDb.db, project.id, user.id);
    expect(format.currentVersionId).toBe(version.id);
    expect(version.versionNo).toBe(1);
    expect(version.rules).toEqual(DEFAULT_FORMAT_RULES);
  });

  it("refuse, at commit, a format whose current version does not exist", async () => {
    const { project } = await setup();
    const error = await pgError(
      testDb.db.transaction(async (tx) => {
        await tx.insert(formats).values({
          projectId: project.id,
          name: "Orphan",
          slug: `orphan-${randomUUID()}`,
          currentVersionId: randomUUID(),
        });
      }),
    );
    expect(error).toEqual({
      code: PG.foreignKeyViolation,
      constraint: "formats_current_version_fk",
    });
  });

  it("refuse a current version that belongs to another format", async () => {
    const { project } = await setup();
    const first = await insertFormat(testDb.db, project.id);
    const second = await insertFormat(testDb.db, project.id);
    const error = await pgError(
      testDb.db
        .update(formats)
        .set({ currentVersionId: second.version.id })
        .where(eq(formats.id, first.format.id)),
    );
    expect(error).toEqual({
      code: PG.foreignKeyViolation,
      constraint: "formats_current_version_fk",
    });
  });

  it("number format versions per format", async () => {
    const { project } = await setup();
    const { format } = await insertFormat(testDb.db, project.id);
    const next = await testDb.db.transaction((tx) => nextFormatVersionNo(tx, format.id));
    expect(next).toBe(2);
    expect(await nextFormatVersionNo(testDb.db, randomUUID())).toBeNull();

    const error = await pgError(
      testDb.db.insert(formatVersions).values({
        formatId: format.id,
        versionNo: 1,
        rules: structuredClone(DEFAULT_FORMAT_RULES),
      }),
    );
    expect(error).toEqual({
      code: PG.uniqueViolation,
      constraint: "format_versions_format_id_version_no_uq",
    });
  });

  it("keep format and series slugs unique per project", async () => {
    const { user, project } = await setup();
    const other = await insertProject(testDb.db, user.id);
    const first = await insertFormat(testDb.db, project.id);
    const second = await insertFormat(testDb.db, project.id);
    const elsewhere = await insertFormat(testDb.db, other.id);

    const formatError = await pgError(
      testDb.db
        .update(formats)
        .set({ slug: first.format.slug })
        .where(eq(formats.id, second.format.id)),
    );
    expect(formatError).toEqual({
      code: PG.uniqueViolation,
      constraint: "formats_project_id_slug_uq",
    });
    await testDb.db
      .update(formats)
      .set({ slug: first.format.slug })
      .where(eq(formats.id, elsewhere.format.id));

    const values = { name: "Weekly", slug: "weekly" };
    const [created] = await testDb.db
      .insert(series)
      .values({ ...values, projectId: project.id, formatId: first.format.id })
      .returning();
    expect(created?.status).toBe("active");
    await testDb.db
      .insert(series)
      .values({ ...values, projectId: other.id, formatId: elsewhere.format.id });
    const seriesError = await pgError(
      testDb.db
        .insert(series)
        .values({ ...values, projectId: project.id, formatId: second.format.id }),
    );
    expect(seriesError).toEqual({
      code: PG.uniqueViolation,
      constraint: "series_project_id_slug_uq",
    });
  });

  it("refuse a series whose format belongs to another project", async () => {
    const { user, project } = await setup();
    const other = await insertProject(testDb.db, user.id);
    const { format } = await insertFormat(testDb.db, other.id);
    const error = await pgError(
      testDb.db
        .insert(series)
        .values({ projectId: project.id, name: "Mixed", slug: "mixed", formatId: format.id }),
    );
    expect(error).toEqual({ code: PG.foreignKeyViolation, constraint: "series_format_fk" });
  });
});

describe("content items and versions", () => {
  it("insert an item and its first version in one transaction", async () => {
    const { project } = await setup();
    const { item, version } = await insertContentItem(testDb.db, { projectId: project.id });
    expect(item.state).toBe("idea");
    expect(item.currentVersionId).toBe(version.id);
    expect(version).toMatchObject({ itemId: item.id, versionNo: 1, stage: "idea" });
  });

  it("refuse, at commit, an item whose current version was never inserted", async () => {
    const { project } = await setup();
    let insertedBeforeCommit = false;
    const error = await pgError(
      testDb.db.transaction(async (tx) => {
        await tx.insert(contentItems).values({
          projectId: project.id,
          title: "No version",
          createdVia: "ui",
          currentVersionId: randomUUID(),
        });
        // The deferred key lets the statement through; only the commit fails.
        insertedBeforeCommit = true;
      }),
    );
    expect(insertedBeforeCommit).toBe(true);
    expect(error).toEqual({
      code: PG.foreignKeyViolation,
      constraint: "content_items_current_version_fk",
    });
  });

  it("refuse a current version that belongs to another item", async () => {
    const { project } = await setup();
    const first = await insertContentItem(testDb.db, { projectId: project.id });
    const second = await insertContentItem(testDb.db, { projectId: project.id });
    const error = await pgError(
      testDb.db
        .update(contentItems)
        .set({ currentVersionId: second.version.id })
        .where(eq(contentItems.id, first.item.id)),
    );
    expect(error).toEqual({
      code: PG.foreignKeyViolation,
      constraint: "content_items_current_version_fk",
    });
  });

  it("refuse a parent version from another item", async () => {
    const { project } = await setup();
    const first = await insertContentItem(testDb.db, { projectId: project.id });
    const second = await insertContentItem(testDb.db, { projectId: project.id });
    const error = await pgError(
      testDb.db.insert(contentVersions).values({
        itemId: first.item.id,
        versionNo: 2,
        stage: "script",
        parentVersionId: second.version.id,
        createdVia: "ui",
      }),
    );
    expect(error).toEqual({
      code: PG.foreignKeyViolation,
      constraint: "content_versions_parent_version_fk",
    });
  });

  it("number versions without gaps under concurrent writers", async () => {
    const { project } = await setup();
    const { item } = await insertContentItem(testDb.db, { projectId: project.id });

    const writers = 8;
    const created = await Promise.all(
      Array.from({ length: writers }, () => appendVersion(testDb.db, item.id)),
    );

    expect(created.map((version) => version.versionNo).sort((a, b) => a - b)).toEqual(
      Array.from({ length: writers }, (_, index) => index + 2),
    );
    // Each writer built on the version committed before it: the parents form one chain.
    const rows = await testDb.db
      .select()
      .from(contentVersions)
      .where(eq(contentVersions.itemId, item.id))
      .orderBy(contentVersions.versionNo);
    for (const [index, row] of rows.entries()) {
      if (index > 0) expect(row.parentVersionId).toBe(rows[index - 1]?.id);
    }
    const [current] = await testDb.db
      .select()
      .from(contentItems)
      .where(eq(contentItems.id, item.id));
    expect(current?.currentVersionId).toBe(rows.at(-1)?.id);
  });

  it("make a waiting writer see the version committed while it waited", async () => {
    const { project } = await setup();
    const { item } = await insertContentItem(testDb.db, { projectId: project.id });

    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let firstLocked: () => void = () => undefined;
    const locked = new Promise<void>((resolve) => {
      firstLocked = resolve;
    });

    const first = testDb.db.transaction(async (tx) => {
      const versionNo = await nextVersionNo(tx, item.id);
      firstLocked();
      await held;
      await tx
        .insert(contentVersions)
        .values({ itemId: item.id, versionNo: versionNo ?? 0, stage: "script", createdVia: "ui" });
      return versionNo;
    });
    await locked;
    const second = testDb.db.transaction((tx) => nextVersionNo(tx, item.id));
    await lockWaiters(1);
    release();

    expect(await first).toBe(2);
    expect(await second).toBe(3);
  });

  it("return null for an item that does not exist", async () => {
    const next = await testDb.db.transaction((tx) => nextVersionNo(tx, randomUUID()));
    expect(next).toBeNull();
  });

  it("refuse a second version for the same job, so job results are idempotent", async () => {
    const { user, project } = await setup();
    const { item } = await insertContentItem(testDb.db, { projectId: project.id });
    const job = await insertJob(testDb.db, {
      projectId: project.id,
      createdBy: user.id,
      type: "content.write_script",
    });

    const version = await appendVersion(testDb.db, item.id, job.id);
    expect(version.jobId).toBe(job.id);

    const error = await pgError(appendVersion(testDb.db, item.id, job.id));
    expect(error).toEqual({ code: PG.uniqueViolation, constraint: "content_versions_job_id_uq" });

    // A replay written as insert-or-skip stores nothing.
    const replay = await testDb.db
      .insert(contentVersions)
      .values({
        itemId: item.id,
        versionNo: 3,
        stage: "script",
        createdVia: "job",
        jobId: job.id,
      })
      .onConflictDoNothing({
        target: contentVersions.jobId,
        where: sql`job_id is not null`,
      })
      .returning();
    expect(replay).toEqual([]);

    // Versions without a job are unlimited.
    await appendVersion(testDb.db, item.id);
    await appendVersion(testDb.db, item.id);
    const rows = await testDb.db
      .select()
      .from(contentVersions)
      .where(eq(contentVersions.itemId, item.id));
    expect(rows.map((row) => row.versionNo).sort()).toEqual([1, 2, 3, 4]);
  });

  it("links an item's conversation and clears it when the item is deleted", async () => {
    const { user, project } = await setup();
    const { item } = await insertContentItem(testDb.db, { projectId: project.id });
    const conversation = await insertConversation(testDb.db, project.id, user.id);
    await testDb.db
      .update(conversations)
      .set({ contentItemId: item.id })
      .where(eq(conversations.id, conversation.id));

    await testDb.db.delete(contentItems).where(eq(contentItems.id, item.id));

    const [row] = await testDb.db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversation.id));
    expect(row?.contentItemId).toBeNull();
    expect(
      await testDb.db.select().from(contentVersions).where(eq(contentVersions.itemId, item.id)),
    ).toEqual([]);
  });

  it("insert an item inside a caller's transaction with the shared helper", async () => {
    const { project } = await setup();
    const { format } = await insertFormat(testDb.db, project.id);
    const [created] = await testDb.db
      .insert(series)
      .values({ projectId: project.id, name: "Shorts", slug: "shorts", formatId: format.id })
      .returning();
    const { item } = await testDb.db.transaction((tx) =>
      insertItemWith(tx, {
        projectId: project.id,
        seriesId: created?.id,
        autopilotTarget: "voice",
      }),
    );
    expect(item.seriesId).toBe(created?.id);
    expect(item.autopilotTarget).toBe("voice");
  });
});

describe("reviews", () => {
  it("require a comment for a request for changes", async () => {
    const { user, project } = await setup();
    const { item, version } = await insertContentItem(testDb.db, { projectId: project.id });
    const base = {
      itemId: item.id,
      versionId: version.id,
      userId: user.id,
      actorKind: "user",
    } as const;

    const error = await pgError(
      testDb.db.insert(reviews).values({ ...base, decision: "request_changes" }),
    );
    expect(error).toEqual({ code: PG.checkViolation, constraint: "reviews_comment_ck" });

    const [review] = await testDb.db
      .insert(reviews)
      .values({
        ...base,
        decision: "request_changes",
        comment: "Shorter hook",
        enqueueRevision: true,
      })
      .returning();
    expect(review?.enqueueRevision).toBe(true);
  });

  it("queue a revision only for a request for changes", async () => {
    const { user, project } = await setup();
    const { item, version } = await insertContentItem(testDb.db, { projectId: project.id });
    const error = await pgError(
      testDb.db.insert(reviews).values({
        itemId: item.id,
        versionId: version.id,
        userId: user.id,
        actorKind: "user",
        decision: "approve",
        enqueueRevision: true,
      }),
    );
    expect(error).toEqual({ code: PG.checkViolation, constraint: "reviews_enqueue_revision_ck" });
  });

  it("refuse a review of another item's version", async () => {
    const { user, project } = await setup();
    const first = await insertContentItem(testDb.db, { projectId: project.id });
    const second = await insertContentItem(testDb.db, { projectId: project.id });
    const error = await pgError(
      testDb.db.insert(reviews).values({
        itemId: first.item.id,
        versionId: second.version.id,
        userId: user.id,
        actorKind: "user",
        decision: "reject",
      }),
    );
    expect(error).toEqual({ code: PG.foreignKeyViolation, constraint: "reviews_version_fk" });
  });
});

describe("assets", () => {
  it("keep one live project-level asset per project, kind and sha256", async () => {
    const { user, project } = await setup();
    const other = await insertProject(testDb.db, user.id);
    const sha256 = randomHash();
    const reference = {
      projectId: project.id,
      kind: "reference_media",
      mime: "video/mp4",
    } as const;

    const [first] = await testDb.db
      .insert(assets)
      .values(assetValues({ ...reference, sha256 }))
      .returning();
    expect(first?.status).toBe("pending");
    expect(first?.itemId).toBeNull();
    expect(first?.meta).toEqual({});

    const error = await pgError(
      testDb.db.insert(assets).values(assetValues({ ...reference, sha256 })),
    );
    expect(error).toEqual({
      code: PG.uniqueViolation,
      constraint: "assets_project_id_kind_sha256_uq",
    });

    // Insert-or-return-existing, as the upload route does.
    const skipped = await testDb.db
      .insert(assets)
      .values(assetValues({ ...reference, sha256 }))
      .onConflictDoNothing({
        target: [assets.projectId, assets.kind, assets.sha256],
        where: sql`item_id is null and status <> 'failed'`,
      })
      .returning();
    expect(skipped).toEqual([]);

    // Another kind, another project or an item may hold the same bytes.
    const { item } = await insertContentItem(testDb.db, { projectId: project.id });
    await testDb.db
      .insert(assets)
      .values([
        assetValues({ projectId: project.id, sha256 }),
        assetValues({ ...reference, projectId: other.id, sha256 }),
        assetValues({ ...reference, itemId: item.id, sha256 }),
      ]);

    // A failed upload does not block a retry of the same bytes.
    await testDb.db
      .update(assets)
      .set({ status: "failed" })
      .where(eq(assets.id, first?.id ?? ""));
    const [retry] = await testDb.db
      .insert(assets)
      .values(assetValues({ ...reference, sha256 }))
      .returning();
    expect(retry?.status).toBe("pending");
  });

  it("keep one live asset per item, kind and sha256, so items never share one", async () => {
    const { project } = await setup();
    const { item: first } = await insertContentItem(testDb.db, { projectId: project.id });
    const { item: second } = await insertContentItem(testDb.db, { projectId: project.id });
    const sha256 = randomHash();

    for (const kind of ["voice", "render"] as const) {
      const mime = kind === "voice" ? "audio/mpeg" : "video/mp4";
      const values = { projectId: project.id, kind, mime, sha256 };
      const [own] = await testDb.db
        .insert(assets)
        .values(assetValues({ ...values, itemId: first.id }))
        .returning();

      const error = await pgError(
        testDb.db.insert(assets).values(assetValues({ ...values, itemId: first.id })),
      );
      expect(error).toEqual({
        code: PG.uniqueViolation,
        constraint: "assets_project_id_item_id_kind_sha256_uq",
      });
      const skipped = await testDb.db
        .insert(assets)
        .values(assetValues({ ...values, itemId: first.id }))
        .onConflictDoNothing({
          target: [assets.projectId, assets.itemId, assets.kind, assets.sha256],
          where: sql`item_id is not null and status <> 'failed'`,
        })
        .returning();
      expect(skipped).toEqual([]);

      // The second item gets an asset of its own for the same bytes.
      const [copy] = await testDb.db
        .insert(assets)
        .values(assetValues({ ...values, itemId: second.id }))
        .returning();
      expect(copy?.id).not.toBe(own?.id);
      expect(copy?.itemId).toBe(second.id);
    }

    // A failed upload does not block a retry of the same bytes for the item.
    await testDb.db
      .update(assets)
      .set({ status: "failed" })
      .where(and(eq(assets.itemId, first.id), eq(assets.kind, "voice")));
    const [retry] = await testDb.db
      .insert(assets)
      .values(assetValues({ projectId: project.id, itemId: first.id, kind: "voice", sha256 }))
      .returning();
    expect(retry?.status).toBe("pending");
  });

  it("keep storage keys unique and digests lowercase hex", async () => {
    const { project } = await setup();
    const storageKey = `test/${randomUUID()}`;
    await testDb.db.insert(assets).values(assetValues({ projectId: project.id, storageKey }));

    const duplicate = await pgError(
      testDb.db.insert(assets).values(assetValues({ projectId: project.id, storageKey })),
    );
    expect(duplicate).toEqual({ code: PG.uniqueViolation, constraint: "assets_storage_key_uq" });

    const upper = await pgError(
      testDb.db
        .insert(assets)
        .values(assetValues({ projectId: project.id, sha256: randomHash().toUpperCase() })),
    );
    expect(upper).toEqual({ code: PG.checkViolation, constraint: "assets_sha256_ck" });
  });

  it("store the probe and a voice take's alignment in meta, and big sizes", async () => {
    const { project } = await setup();
    const { item } = await insertContentItem(testDb.db, { projectId: project.id });
    const meta: AssetMeta = {
      probe: { durationMs: 1_200, sampleRate: 44_100, channels: 1 },
      alignment: { words: [{ text: "hello", startMs: 0, endMs: 400 }] },
    };
    const [asset] = await testDb.db
      .insert(assets)
      .values(
        assetValues({
          projectId: project.id,
          itemId: item.id,
          bytes: 3 * 1024 ** 3,
          meta,
        }),
      )
      .returning();
    expect(asset?.bytes).toBe(3 * 1024 ** 3);
    expect(asset?.meta).toEqual(meta);
  });

  it("cannot be deleted while a version uses it", async () => {
    const { project } = await setup();
    const { item } = await insertContentItem(testDb.db, { projectId: project.id });
    const [voice] = await testDb.db
      .insert(assets)
      .values(assetValues({ projectId: project.id, itemId: item.id, status: "ready" }))
      .returning();
    await testDb.db.insert(contentVersions).values({
      itemId: item.id,
      versionNo: 2,
      stage: "voice",
      voiceAssetId: voice?.id,
      createdVia: "job",
    });

    const error = await pgError(testDb.db.delete(assets).where(eq(assets.id, voice?.id ?? "")));
    expect(error).toEqual({
      code: PG.foreignKeyViolation,
      constraint: "content_versions_voice_asset_id_assets_id_fk",
    });

    // Deleting the item removes its versions and assets together.
    await testDb.db.delete(contentItems).where(eq(contentItems.id, item.id));
    expect(await testDb.db.select().from(assets).where(eq(assets.itemId, item.id))).toEqual([]);
  });

  it("link reference media to a reference and unlink it when the asset goes", async () => {
    const { project } = await setup();
    const entry = await insertKbEntry(testDb.db, { projectId: project.id, kind: "reference" });
    const [media] = await testDb.db
      .insert(assets)
      .values(assetValues({ projectId: project.id, kind: "reference_media", mime: "video/mp4" }))
      .returning();
    await testDb.db.insert(kbReferences).values({
      entryId: entry.id,
      url: "https://example.com/v/2",
      platform: "other",
      mediaAssetId: media?.id,
    });

    await testDb.db.delete(assets).where(eq(assets.id, media?.id ?? ""));

    const [reference] = await testDb.db
      .select()
      .from(kbReferences)
      .where(eq(kbReferences.entryId, entry.id));
    expect(reference?.mediaAssetId).toBeNull();
  });
});

describe("skills", () => {
  it("publish a skill with its first version in one transaction", async () => {
    const name = `skill-${randomUUID().slice(0, 8)}`;
    const { skill, version } = await insertSkill(testDb.db, name, "recipe");
    expect(skill.currentVersionId).toBe(version.id);
    expect(skill.kind).toBe("recipe");
    expect(version.checksum).toMatch(/^[0-9a-f]{64}$/);

    const error = await pgError(insertSkill(testDb.db, name));
    expect(error).toEqual({ code: PG.uniqueViolation, constraint: "skills_name_uq" });
  });

  it("refuse the same checksum twice for one skill, but not across skills", async () => {
    const first = await insertSkill(testDb.db, `skill-${randomUUID().slice(0, 8)}`);
    const second = await insertSkill(testDb.db, `skill-${randomUUID().slice(0, 8)}`);
    const { files, checksum } = skillFiles("shared");

    const next = await testDb.db.transaction((tx) => nextSkillVersion(tx, first.skill.id));
    expect(next).toBe(2);
    await testDb.db
      .insert(skillVersions)
      .values({ skillId: first.skill.id, version: 2, files, checksum });

    const error = await pgError(
      testDb.db
        .insert(skillVersions)
        .values({ skillId: first.skill.id, version: 3, files, checksum }),
    );
    expect(error).toEqual({
      code: PG.uniqueViolation,
      constraint: "skill_versions_skill_id_checksum_uq",
    });

    await testDb.db
      .insert(skillVersions)
      .values({ skillId: second.skill.id, version: 2, files, checksum });
  });

  it("refuse a duplicate version number, a bad checksum and a bad name", async () => {
    const { skill, version } = await insertSkill(testDb.db, `skill-${randomUUID().slice(0, 8)}`);
    const { files, checksum } = skillFiles("again");

    const duplicate = await pgError(
      testDb.db.insert(skillVersions).values({ skillId: skill.id, version: 1, files, checksum }),
    );
    expect(duplicate).toEqual({
      code: PG.uniqueViolation,
      constraint: "skill_versions_skill_id_version_uq",
    });

    const badChecksum = await pgError(
      testDb.db
        .insert(skillVersions)
        .values({ skillId: skill.id, version: 2, files, checksum: "x".repeat(64) }),
    );
    expect(badChecksum).toEqual({
      code: PG.checkViolation,
      constraint: "skill_versions_checksum_ck",
    });

    const badName = await pgError(
      testDb.db.update(skills).set({ name: "Not/Allowed" }).where(eq(skills.id, skill.id)),
    );
    expect(badName).toEqual({ code: PG.checkViolation, constraint: "skills_name_ck" });
    expect(version.version).toBe(1);
  });

  it("refuse, at commit, a skill whose current version was never inserted", async () => {
    const error = await pgError(
      testDb.db.transaction(async (tx) => {
        await tx.insert(skills).values({
          name: `skill-${randomUUID().slice(0, 8)}`,
          kind: "skill",
          currentVersionId: randomUUID(),
        });
      }),
    );
    expect(error).toEqual({
      code: PG.foreignKeyViolation,
      constraint: "skills_current_version_fk",
    });
  });
});

describe("pipeline job types", () => {
  it("are accepted by jobs", async () => {
    const { user, project } = await setup();
    for (const type of [
      "content.write_script",
      "content.storyboard",
      "content.revise",
      "content.voice",
      "content.render",
      "skills.sync",
    ] as const) {
      const job = await insertJob(testDb.db, { projectId: project.id, createdBy: user.id, type });
      expect(job.type).toBe(type);
    }
  });
});
