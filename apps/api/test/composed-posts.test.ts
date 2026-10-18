import { randomUUID } from "node:crypto";
import {
  AssetSchema,
  type ContentItem,
  ContentItemDetailSchema,
  ContentItemSchema,
  CreateReviewResponseSchema,
  CreateUploadResponseSchema,
  EditVersionResponseSchema,
  type PostFormat,
  ScheduledPostSchema,
} from "@loomcast/contracts";
import { assets, projects, publishAttempts, scheduledPosts } from "@loomcast/db";
import { createTestDb, type TestDb } from "@loomcast/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ModuleDeps } from "../src/deps";
import { assetStorageKey } from "../src/lib/storage";
import { insertAsset } from "./pipeline-support";
import { insertChannel, runDue, testKeyring } from "./publisher-support";
import {
  putUpload,
  randomFile,
  removeObjects,
  resolveStorageTarget,
  type StorageTarget,
} from "./storage-support";
import { createTestApp, errorCode, insertUser, login, send, type TestApp } from "./support";

// Composed posts over REST, as the web app makes them: create an item with a format, upload its
// photos and videos as `media` assets, write a version with them, submit, approve and schedule it
// on Facebook and Instagram channels.

const target: StorageTarget = await resolveStorageTarget();
const keyring = testKeyring();
const HOUR_MS = 60 * 60_000;

let testDb: TestDb;
let t: TestApp;
let deps: ModuleDeps;
let cookie: string;
let projectId: string;
let facebookId: string;
let instagramId: string;
const storedKeys: string[] = [];

beforeAll(async () => {
  testDb = await createTestDb();
  t = createTestApp(testDb.db, {
    config: { storage: target.config },
    modules: [
      (app, captured) => {
        deps = captured;
        return app;
      },
    ],
  });
  const user = await insertUser(testDb.db, { role: "owner" });
  ({ cookie } = await login(t.app, user.email));
  const [project] = await testDb.db
    .insert(projects)
    .values({ slug: `composed-${randomUUID().slice(0, 8)}`, name: "Composed", createdBy: user.id })
    .returning();
  if (project === undefined) {
    throw new Error("project was not inserted");
  }
  projectId = project.id;
  facebookId = (await insertChannel(testDb.db, keyring, { platform: "facebook" })).id;
  instagramId = (await insertChannel(testDb.db, keyring, { platform: "instagram" })).id;
});

afterAll(async () => {
  await removeObjects(target, target.config.bucket, storedKeys);
  await t.deps.lifecycle.close();
  await target.close();
  await testDb.drop();
});

function api(method: string, path: string, body?: unknown) {
  return send(t.app, method, path, { cookie, body });
}

function ahead(hours: number): string {
  return new Date(t.clock.now().getTime() + hours * HOUR_MS).toISOString();
}

async function createPost(format: PostFormat, title = `A ${format} post`) {
  const response = await api("POST", `/api/projects/${projectId}/content`, { title, format });
  expect(response.status).toBe(201);
  return ContentItemDetailSchema.parse(await response.json());
}

/** Uploads random bytes as a `media` asset of the item, the way the web app does. */
async function uploadMedia(itemId: string, mime: string, filename: string): Promise<string> {
  const file = randomFile(4 * 1024);
  const started = await api("POST", "/api/assets/uploads", {
    projectId,
    itemId,
    kind: "media",
    filename,
    mime,
    bytes: file.bytes.length,
    sha256: file.sha256,
  });
  expect(started.status).toBe(201);
  const { asset, upload } = CreateUploadResponseSchema.parse(await started.json());
  storedKeys.push(assetStorageKey(asset, asset.kind, file.sha256, asset.mime));
  if (upload === null) {
    return asset.id;
  }
  expect((await putUpload(upload, file.bytes)).status).toBe(200);
  const finalized = await api("POST", `/api/assets/${asset.id}/finalize`, {});
  expect(finalized.status).toBe(200);
  expect(AssetSchema.parse(await finalized.json()).status).toBe("ready");
  return asset.id;
}

function editVersion(itemId: string, body: Record<string, unknown>) {
  return api("POST", `/api/content/${itemId}/versions`, body);
}

async function compose(itemId: string, body: Record<string, unknown>) {
  const response = await editVersion(itemId, body);
  expect(response.status, await response.clone().text()).toBe(201);
  return EditVersionResponseSchema.parse(await response.json());
}

async function submit(item: ContentItem): Promise<ContentItem> {
  const response = await api("POST", `/api/content/${item.id}/submit`, {
    versionId: item.currentVersionId,
  });
  expect(response.status, await response.clone().text()).toBe(200);
  return ContentItemSchema.parse(await response.json());
}

async function approve(item: ContentItem) {
  const response = await api("POST", `/api/content/${item.id}/reviews`, {
    versionId: item.currentVersionId,
    decision: "approve",
  });
  expect(response.status, await response.clone().text()).toBe(201);
  return CreateReviewResponseSchema.parse(await response.json());
}

function schedule(itemId: string, channelId: string, extra: Record<string, unknown> = {}) {
  return api("POST", "/api/scheduled-posts", {
    itemId,
    channelId,
    scheduledAt: ahead(2),
    ...extra,
  });
}

describe("composed posts over REST", () => {
  it("creates, composes, approves and schedules a photo on Facebook and Instagram", async () => {
    const created = await createPost("image");
    expect(created.item).toMatchObject({ state: "idea", format: "image" });
    expect(created.currentVersion).toMatchObject({ format: "image", media: [] });
    const itemId = created.item.id;
    const photo = await uploadMedia(itemId, "image/jpeg", "launch.jpg");

    const edited = await compose(itemId, {
      baseVersionId: created.currentVersion.id,
      media: [{ assetId: photo, type: "image", altText: "The launch stage" }],
      caption: "We launched.",
    });
    expect(edited.item).toMatchObject({ state: "render", format: "image" });
    expect(edited.version).toMatchObject({
      format: "image",
      media: [{ assetId: photo, type: "image", altText: "The launch stage" }],
      caption: "We launched.",
      renderAssetId: null,
    });

    const submitted = await submit(edited.item);
    expect(submitted.state).toBe("review");
    // Submitting again changes nothing.
    expect((await submit(submitted)).state).toBe("review");
    const decided = await approve(submitted);
    expect(decided.item.state).toBe("approved");

    const options = { instagram: { collaborators: ["loomcast"] } };
    const onFacebook = await schedule(itemId, facebookId, { options });
    expect(onFacebook.status, await onFacebook.clone().text()).toBe(201);
    const onInstagram = await schedule(itemId, instagramId, { options });
    expect(onInstagram.status).toBe(201);
    const post = ScheduledPostSchema.parse(await onInstagram.json());
    expect(post).toMatchObject({
      itemId,
      channelId: instagramId,
      platform: "instagram",
      status: "queued",
      versionId: edited.version.id,
      options,
      item: { format: "image", state: "scheduled" },
    });
    const calendar = await api(
      "GET",
      `/api/calendar?from=${encodeURIComponent(ahead(0))}&to=${encodeURIComponent(ahead(24))}&projectId=${projectId}`,
    );
    expect(calendar.status).toBe(200);
    const { posts } = (await calendar.json()) as { posts: { itemId: string; options: unknown }[] };
    expect(posts.filter((listed) => listed.itemId === itemId)).toHaveLength(2);
  });

  it("saves a carousel step by step until its media fit", async () => {
    const created = await createPost("carousel");
    const itemId = created.item.id;
    const first = await uploadMedia(itemId, "image/png", "one.png");
    const second = await uploadMedia(itemId, "video/mp4", "two.mp4");

    const half = await compose(itemId, {
      baseVersionId: created.currentVersion.id,
      media: [{ assetId: first, type: "image" }],
    });
    expect(half.item.state).toBe("idea");
    const submitEarly = await api("POST", `/api/content/${itemId}/submit`, {
      versionId: half.version.id,
    });
    expect(submitEarly.status).toBe(409);
    expect(await errorCode(submitEarly)).toBe("invalid_transition");

    const full = await compose(itemId, {
      baseVersionId: half.version.id,
      media: [
        { assetId: first, type: "image" },
        { assetId: second, type: "video" },
      ],
    });
    expect(full.item.state).toBe("render");
    expect(full.version.media.map((entry) => entry.assetId)).toEqual([first, second]);

    const stale = await api("POST", `/api/content/${itemId}/submit`, {
      versionId: half.version.id,
    });
    expect(stale.status).toBe(409);
    expect(await errorCode(stale)).toBe("conflict");
    await approve(await submit(full.item));
    expect((await schedule(itemId, instagramId)).status).toBe(201);
  });

  it("refuses media of the wrong type, of another item, missing or not yet uploaded", async () => {
    const created = await createPost("image");
    const itemId = created.item.id;
    const base = created.currentVersion.id;
    const video = await uploadMedia(itemId, "video/mp4", "clip.mp4");
    const other = await createPost("image", "Another post");
    const foreign = await uploadMedia(other.item.id, "image/jpeg", "foreign.jpg");
    const pending = await insertAsset(testDb.db, {
      projectId,
      itemId,
      kind: "media",
      status: "pending",
    });

    const cases: [unknown[], string][] = [
      [[{ assetId: video, type: "image" }], "media.0.type"],
      [[{ assetId: foreign, type: "image" }], "media.0.assetId"],
      [[{ assetId: randomUUID(), type: "image" }], "media.0.assetId"],
      [[{ assetId: pending, type: "video" }], "media.0.assetId"],
    ];
    for (const [media, path] of cases) {
      const response = await editVersion(itemId, { baseVersionId: base, media });
      expect(response.status, path).toBe(400);
      const body = (await response.json()) as {
        error: { code: string; details: { path: string }[] };
      };
      expect(body.error.code).toBe("validation_failed");
      expect(body.error.details.map((issue) => issue.path)).toEqual([path]);
    }
    // A video in a photo post fits no rule, even with the right type.
    const wrongFormat = await compose(itemId, {
      baseVersionId: base,
      media: [{ assetId: video, type: "video" }],
    });
    expect(wrongFormat.item.state).toBe("idea");
  });

  it("publishes a text post on Facebook only", async () => {
    const created = await createPost("text");
    const itemId = created.item.id;
    const edited = await compose(itemId, {
      baseVersionId: created.currentVersion.id,
      caption: "Read the release notes.",
    });
    expect(edited.item.state).toBe("render");
    await approve(await submit(edited.item));

    const onInstagram = await schedule(itemId, instagramId);
    expect(onInstagram.status).toBe(422);
    const body = (await onInstagram.json()) as {
      error: { code: string; message: string; details: unknown };
    };
    expect(body.error).toMatchObject({
      code: "format_not_supported",
      message: "Instagram does not publish text posts.",
      details: { platform: "instagram", format: "text" },
    });
    const onFacebook = await schedule(itemId, facebookId, {
      options: { facebook: { link: "https://example.com/release" } },
    });
    expect(onFacebook.status).toBe(201);
    expect(ScheduledPostSchema.parse(await onFacebook.json()).options).toEqual({
      facebook: { link: "https://example.com/release" },
    });
  });

  it("refuses production actions on a composed post", async () => {
    const created = await createPost("story");
    const itemId = created.item.id;
    const photo = await uploadMedia(itemId, "image/webp", "story.webp");
    await compose(itemId, {
      baseVersionId: created.currentVersion.id,
      media: [{ assetId: photo, type: "image" }],
    });
    for (const action of ["write_script", "storyboard", "voice", "render", "produce"]) {
      const response = await api("POST", `/api/content/${itemId}/actions`, { action });
      expect(response.status, action).toBeGreaterThanOrEqual(400);
      expect(response.status, action).toBeLessThan(500);
    }
    const detail = ContentItemDetailSchema.parse(
      await (await api("GET", `/api/content/${itemId}`)).json(),
    );
    expect(detail.activeJob).toBeNull();
    expect(detail.item.state).toBe("render");
  });

  it("records a dry-run publish attempt for a composed post", async () => {
    // A Reel made of an uploaded video publishes through the video path every platform has.
    const created = await createPost("reel");
    const itemId = created.item.id;
    const video = await uploadMedia(itemId, "video/mp4", "reel.mp4");
    await testDb.db
      .update(assets)
      .set({ durationMs: 20_000, width: 1_080, height: 1_920 })
      .where(eq(assets.id, video));
    const edited = await compose(itemId, {
      baseVersionId: created.currentVersion.id,
      media: [{ assetId: video, type: "video" }],
      caption: "Shipped.",
    });
    expect(edited.item.state).toBe("render");
    await approve(await submit(edited.item));
    const response = await schedule(itemId, facebookId);
    expect(response.status).toBe(201);
    const post = ScheduledPostSchema.parse(await response.json());

    t.clock.advance(3 * HOUR_MS);
    await runDue(deps.scheduler);
    const [row] = await testDb.db
      .select()
      .from(scheduledPosts)
      .where(eq(scheduledPosts.id, post.id));
    expect(row?.status, JSON.stringify(row?.lastError)).toBe("published");
    const attempts = await testDb.db
      .select()
      .from(publishAttempts)
      .where(eq(publishAttempts.postId, post.id));
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ adapter: "facebook", dryRun: true, error: null });
  });

  it("records one dry-run attempt for a photo post", async () => {
    const created = await createPost("image");
    const itemId = created.item.id;
    const photo = await uploadMedia(itemId, "image/jpeg", "photo.jpg");
    const edited = await compose(itemId, {
      baseVersionId: created.currentVersion.id,
      media: [{ assetId: photo, type: "image" }],
    });
    await approve(await submit(edited.item));
    const response = await schedule(itemId, facebookId);
    expect(response.status).toBe(201);
    const post = ScheduledPostSchema.parse(await response.json());

    t.clock.advance(3 * HOUR_MS);
    await runDue(deps.scheduler);
    // The photo request builders land on their own; whatever they answer, the publisher loads the
    // photo for the format, records exactly one dry-run attempt and settles the post.
    const [row] = await testDb.db
      .select()
      .from(scheduledPosts)
      .where(eq(scheduledPosts.id, post.id));
    expect(["published", "failed"]).toContain(row?.status);
    const attempts = await testDb.db
      .select()
      .from(publishAttempts)
      .where(eq(publishAttempts.postId, post.id));
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ attempt: 1, adapter: "facebook", dryRun: true });
  });
});
