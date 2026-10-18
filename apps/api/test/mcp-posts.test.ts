import { randomUUID } from "node:crypto";
import {
  CalendarListPostsOutputSchema,
  ContentUploadAssetOutputSchema,
  type Platform,
  PostComposedOutputSchema,
  PostFormatsOutputSchema,
  PostScheduleOutputSchema,
  postFormatCatalog,
  type TokenScope,
} from "@loomcast/contracts";
import {
  apiTokens,
  assets,
  auditLog,
  channels,
  contentItems,
  projects,
  reviews,
  scheduledPosts,
} from "@loomcast/db";
import { createTestDb, type TestDb } from "@loomcast/db/testing";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ModuleDeps } from "../src/deps";
import { generatePrefixedToken } from "../src/lib/crypto";
import { contentServiceFor } from "../src/modules/content";
import { TOOL_CALL_AUDIT_ACTION } from "../src/modules/mcp";
import {
  connectClient,
  issueJobToken,
  issueToken,
  type McpTestServer,
  startMcpTestServer,
} from "./mcp-support";
import {
  putUpload,
  randomFile,
  removeObjects,
  resolveStorageTarget,
  type StorageTarget,
} from "./storage-support";
import { insertUser } from "./support";

type CallResult = Awaited<ReturnType<Client["callTool"]>>;

const HOUR_MS = 60 * 60_000;
const target: StorageTarget = await resolveStorageTarget();

let testDb: TestDb;
let server: McpTestServer;
let moduleDeps: ModuleDeps;
let ownerId: string;
let ownerTokenId: string;
let owner: Client;
let writer: Client;
let projectId: string;
let facebookId: string;
let instagramId: string;
const clients: Client[] = [];
const storedKeys: string[] = [];

beforeAll(async () => {
  testDb = await createTestDb();
  server = await startMcpTestServer(
    testDb.db,
    [
      (app, captured) => {
        moduleDeps = captured;
        return app;
      },
    ],
    { storage: target.config },
  );
  ownerId = (await insertUser(testDb.db, { role: "owner" })).id;
  const issued = await issueToken(server.deps, ownerId, ["mcp:read", "mcp:write", "mcp:admin"]);
  ownerTokenId = issued.row.id;
  owner = await connectClient(server.url, issued.secret);
  writer = await connectClient(
    server.url,
    (await issueToken(server.deps, ownerId, ["mcp:read", "mcp:write"])).secret,
  );
  const [project] = await testDb.db
    .insert(projects)
    .values({ slug: `posts-${randomUUID().slice(0, 8)}`, name: "Posts", createdBy: ownerId })
    .returning();
  if (project === undefined) {
    throw new Error("project was not inserted");
  }
  projectId = project.id;
  facebookId = await newChannel("facebook");
  instagramId = await newChannel("instagram");
});

afterAll(async () => {
  for (const client of [owner, writer, ...clients]) {
    await client?.close();
  }
  await server?.close();
  await removeObjects(target, target.config.bucket, storedKeys);
  await target.close();
  await testDb?.drop();
});

function textOf(result: CallResult): string {
  const [first] = result.content as { type: string; text: string }[];
  return first?.text ?? "";
}

function expectOk(result: CallResult): void {
  expect(result.isError, textOf(result)).toBeFalsy();
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  return client.callTool({ name, arguments: args });
}

/** A planning channel in dry-run, without credentials. */
async function newChannel(
  platform: Platform,
  status: "disconnected" | "disabled" = "disconnected",
) {
  const [row] = await testDb.db
    .insert(channels)
    .values({
      platform,
      displayName: `${platform} ${randomUUID().slice(0, 6)}`,
      status,
      dryRun: true,
    })
    .returning({ id: channels.id });
  if (row === undefined) {
    throw new Error("channel was not inserted");
  }
  return row.id;
}

function ahead(hours: number): string {
  return new Date(server.clock.now().getTime() + hours * HOUR_MS).toISOString();
}

async function stateOf(itemId: string) {
  const [row] = await testDb.db
    .select({ state: contentItems.state })
    .from(contentItems)
    .where(eq(contentItems.id, itemId));
  return row?.state;
}

async function postsOf(itemId: string) {
  return testDb.db.select().from(scheduledPosts).where(eq(scheduledPosts.itemId, itemId));
}

/** A token stored with `scopes` as they are, whatever its user's role. */
async function storedToken(userId: string, scopes: TokenScope[]): Promise<string> {
  const generated = generatePrefixedToken("mcp");
  await testDb.db.insert(apiTokens).values({
    userId,
    kind: "mcp",
    name: "stored token",
    tokenHash: generated.hash,
    prefix: generated.prefix,
    scopes,
  });
  return generated.secret;
}

async function createPost(args: Record<string, unknown>) {
  const result = await call(owner, "post.create", { projectId, title: "A post", ...args });
  expectOk(result);
  return PostComposedOutputSchema.parse(result.structuredContent);
}

async function compose(args: Record<string, unknown>) {
  const result = await call(owner, "post.compose", args);
  expectOk(result);
  return PostComposedOutputSchema.parse(result.structuredContent);
}

/** Uploads random bytes as a `media` asset of the item through the MCP upload tools. */
async function uploadMedia(itemId: string, mime: string, filename: string): Promise<string> {
  const file = randomFile(2 * 1024);
  const started = await call(owner, "content.upload_asset", {
    itemId,
    kind: "media",
    filename,
    mime,
    bytes: file.bytes.length,
    sha256: file.sha256,
  });
  expectOk(started);
  const { asset, upload } = ContentUploadAssetOutputSchema.parse(started.structuredContent);
  const [row] = await testDb.db.select().from(assets).where(eq(assets.id, asset.id));
  if (row !== undefined) storedKeys.push(row.storageKey);
  expect(asset).toMatchObject({ kind: "media", itemId, status: "pending" });
  if (upload === null) {
    throw new Error("expected an upload");
  }
  expect((await putUpload(upload, file.bytes)).status).toBe(200);
  expectOk(await call(owner, "content.finalize_asset", { assetId: asset.id }));
  return asset.id;
}

describe("composed posts over MCP", () => {
  it("lists the formats from the contracts' tables, for any reading token", async () => {
    const result = await call(writer, "post.formats", {});
    expectOk(result);
    expect(PostFormatsOutputSchema.parse(result.structuredContent)).toEqual(postFormatCatalog());
    expect(textOf(result)).toBe("6 post formats on 4 platforms.");
  });

  it("creates, uploads, composes and schedules a photo on Facebook and Instagram", async () => {
    const created = await createPost({ format: "image", title: "Launch photo" });
    expect(created.item).toMatchObject({ state: "idea", format: "image", createdVia: "mcp" });
    expect(created.issues).toEqual(["A photo post needs at least 1 item."]);
    expect(created.next).toContain("content.upload_asset (kind media");
    const itemId = created.item.id;

    const photo = await uploadMedia(itemId, "image/jpeg", "launch.jpg");
    const composed = await compose({
      itemId,
      baseVersionId: created.version.id,
      media: [{ assetId: photo, altText: "The stage at the launch" }],
      caption: "We launched today.",
    });
    expect(composed.item.state).toBe("render");
    expect(composed.issues).toEqual([]);
    expect(composed.version).toMatchObject({
      format: "image",
      media: [{ assetId: photo, type: "image", altText: "The stage at the launch" }],
      caption: "We launched today.",
      createdVia: "mcp",
    });
    expect(composed.next).toContain("post.schedule");

    const scheduledAt = ahead(24);
    const options = { instagram: { collaborators: ["loomcast"] } };
    const result = await call(owner, "post.schedule", {
      itemId,
      versionId: composed.version.id,
      channelIds: [facebookId, instagramId],
      scheduledAt,
      options,
    });
    expectOk(result);
    const scheduled = PostScheduleOutputSchema.parse(result.structuredContent);
    expect(scheduled).toMatchObject({ itemId, versionId: composed.version.id, state: "scheduled" });
    expect(scheduled.posts.map((post) => [post.channelId, post.platform, post.status])).toEqual([
      [facebookId, "facebook", "queued"],
      [instagramId, "instagram", "queued"],
    ]);
    expect(scheduled.posts.every((post) => post.scheduledAt === scheduledAt)).toBe(true);
    expect(textOf(result)).toContain(`Scheduled item ${itemId} on 2 channels`);

    // The approval on the way is the owner's own review.
    const [review] = await testDb.db
      .select()
      .from(reviews)
      .where(eq(reviews.id, scheduled.reviewId ?? ""));
    expect(review).toMatchObject({
      itemId,
      versionId: composed.version.id,
      decision: "approve",
      userId: ownerId,
      actorKind: "user",
    });
    const audits = await testDb.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, TOOL_CALL_AUDIT_ACTION),
          eq(auditLog.targetId, "post.schedule"),
          eq(auditLog.actorId, ownerTokenId),
        ),
      );
    expect(audits).toContainEqual(
      expect.objectContaining({
        data: {
          outcome: "ok",
          projectId,
          itemId,
          reviewId: scheduled.reviewId,
          postIds: scheduled.posts.map((post) => post.id),
        },
      }),
    );

    const calendar = await call(owner, "calendar.list_posts", {
      from: ahead(0),
      to: ahead(48),
      projectId,
    });
    expectOk(calendar);
    const listed = CalendarListPostsOutputSchema.parse(calendar.structuredContent).posts.filter(
      (post) => post.itemId === itemId,
    );
    expect(listed).toHaveLength(2);
    expect(listed.every((post) => post.item.format === "image")).toBe(true);
    expect(listed.every((post) => JSON.stringify(post.options) === JSON.stringify(options))).toBe(
      true,
    );
  });

  it("saves a carousel step by step and refuses to schedule it before its media fit", async () => {
    const created = await createPost({ format: "carousel" });
    const itemId = created.item.id;
    const first = await uploadMedia(itemId, "image/png", "one.png");
    const half = await compose({ itemId, media: [{ assetId: first }] });
    expect(half.item.state).toBe("idea");
    expect(half.issues).toEqual(["A carousel needs at least 2 items."]);

    const early = await call(owner, "post.schedule", {
      itemId,
      channelIds: [instagramId],
      scheduledAt: ahead(24),
    });
    expect(early.isError).toBe(true);
    expect(textOf(early)).toBe(
      "missing_artifact: The post is not ready: A carousel needs at least 2 items.",
    );

    const second = await uploadMedia(itemId, "video/mp4", "two.mp4");
    const full = await compose({
      itemId,
      baseVersionId: half.version.id,
      media: [{ assetId: first }, { assetId: second }],
    });
    expect(full.item.state).toBe("render");
    expect(full.version.media.map((entry) => entry.type)).toEqual(["image", "video"]);

    const stale = await call(owner, "post.compose", {
      itemId,
      baseVersionId: half.version.id,
      caption: "Too late",
    });
    expect(stale.isError).toBe(true);
    expect(textOf(stale)).toMatch(/^conflict: /);

    expectOk(
      await call(owner, "post.schedule", {
        itemId,
        channelIds: [instagramId],
        scheduledAt: ahead(24),
      }),
    );
    expect(await stateOf(itemId)).toBe("scheduled");
  });

  it("schedules a story from an item already in review", async () => {
    const created = await createPost({ format: "story" });
    const itemId = created.item.id;
    const clip = await uploadMedia(itemId, "video/quicktime", "story.mov");
    const composed = await compose({ itemId, media: [{ assetId: clip }] });
    expect(composed.item.state).toBe("render");
    // Submitted in the web app first.
    const submitted = await contentServiceFor(moduleDeps).submit(
      itemId,
      { versionId: composed.version.id },
      { kind: "user", id: ownerId, userId: ownerId },
    );
    expect(submitted.state).toBe("review");

    const result = await call(owner, "post.schedule", {
      itemId,
      channelIds: [instagramId],
      scheduledAt: ahead(5),
    });
    expectOk(result);
    const scheduled = PostScheduleOutputSchema.parse(result.structuredContent);
    expect(scheduled.reviewId).not.toBeNull();
    expect(scheduled.posts[0]?.item.format).toBe("story");
  });

  it("refuses a text post on Instagram without changing anything, then posts it on Facebook", async () => {
    const created = await createPost({ format: "text", caption: "Read the release notes." });
    expect(created.item.state).toBe("render");
    expect(created.version.caption).toBe("Read the release notes.");
    const itemId = created.item.id;

    const refused = await call(owner, "post.schedule", {
      itemId,
      channelIds: [facebookId, instagramId],
      scheduledAt: ahead(24),
    });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toMatch(
      /^format_not_supported: No post was scheduled\. channelIds\.1: .* \(Instagram\): Instagram does not publish text posts\.$/,
    );
    expect(await stateOf(itemId)).toBe("render");
    expect(await postsOf(itemId)).toEqual([]);

    const result = await call(owner, "post.schedule", {
      itemId,
      channelIds: [facebookId],
      scheduledAt: ahead(24),
      options: { facebook: { link: "https://example.com/release" } },
    });
    expectOk(result);
    const [post] = PostScheduleOutputSchema.parse(result.structuredContent).posts;
    expect(post?.options).toEqual({ facebook: { link: "https://example.com/release" } });
  });

  it("is all or nothing: refused channels and a bad time leave the item as it was", async () => {
    const created = await createPost({ format: "text", caption: "Hello." });
    const itemId = created.item.id;
    const disabled = await newChannel("facebook", "disabled");
    const unknown = randomUUID();

    const refused = await call(owner, "post.schedule", {
      itemId,
      channelIds: [facebookId, unknown, disabled],
      scheduledAt: ahead(24),
    });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toMatch(
      /^validation_failed: No post was scheduled: some channels were refused\. \(channelIds\.1: No channel has that id; channelIds\.2: .*: the channel is disabled\)$/,
    );

    // The time is checked by the calendar after the approval: the approval is rolled back too.
    const tooSoon = await call(owner, "post.schedule", {
      itemId,
      channelIds: [facebookId],
      scheduledAt: ahead(0),
    });
    expect(tooSoon.isError).toBe(true);
    expect(textOf(tooSoon)).toMatch(/^validation_failed: .*scheduledAt: /);
    expect(await stateOf(itemId)).toBe("render");
    expect(await postsOf(itemId)).toEqual([]);
    expect(await testDb.db.select().from(reviews).where(eq(reviews.itemId, itemId))).toEqual([]);

    expectOk(
      await call(owner, "post.schedule", {
        itemId,
        channelIds: [facebookId],
        scheduledAt: ahead(24),
      }),
    );
    const again = await call(owner, "post.schedule", {
      itemId,
      channelIds: [facebookId],
      scheduledAt: ahead(30),
    });
    expect(textOf(again)).toMatch(/^validation_failed: .*the item already has a post here/);
  });

  it("checks the media and the versions it is given", async () => {
    const created = await createPost({ format: "image" });
    const itemId = created.item.id;
    const other = await createPost({ format: "image", title: "Another post" });
    const foreign = await uploadMedia(other.item.id, "image/jpeg", "foreign.jpg");
    for (const assetId of [foreign, randomUUID()]) {
      const result = await call(owner, "post.compose", { itemId, media: [{ assetId }] });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toBe(
        "validation_failed: The request is not valid. (media.0.assetId: No media asset with that id on this item)",
      );
    }
    const nothing = await call(owner, "post.compose", { itemId });
    expect(nothing.isError).toBe(true);
    const missing = await call(owner, "post.compose", { itemId: randomUUID(), caption: "x" });
    expect(textOf(missing)).toBe("not_found: No content item has that id.");
    const noProject = await call(owner, "post.create", {
      projectId: randomUUID(),
      title: "Nowhere",
      format: "image",
    });
    expect(noProject.isError).toBe(true);
    expect(textOf(noProject)).toMatch(/^not_found: /);
  });
});

describe("post tool access", () => {
  it("refuses tokens without mcp:admin", async () => {
    const created = await createPost({ format: "text", caption: "Scoped." });
    for (const [name, args] of [
      ["post.create", { projectId, title: "No", format: "image" }],
      ["post.compose", { itemId: created.item.id, caption: "No" }],
      [
        "post.schedule",
        { itemId: created.item.id, channelIds: [facebookId], scheduledAt: ahead(24) },
      ],
    ] as const) {
      const result = await call(writer, name, args);
      expect(result.isError, name).toBe(true);
      expect(textOf(result), name).toMatch(/^forbidden: .*mcp:admin/);
    }
    expect(await stateOf(created.item.id)).toBe("render");
  });

  it("refuses an admin who is not the owner", async () => {
    const admin = await insertUser(testDb.db, { role: "admin" });
    const client = await connectClient(
      server.url,
      await storedToken(admin.id, ["mcp:read", "mcp:write", "mcp:admin"]),
    );
    clients.push(client);
    const created = await createPost({ format: "text", caption: "Owner's." });
    for (const [name, args] of [
      ["post.create", { projectId, title: "No", format: "image" }],
      ["post.compose", { itemId: created.item.id, caption: "No" }],
      [
        "post.schedule",
        { itemId: created.item.id, channelIds: [facebookId], scheduledAt: ahead(24) },
      ],
    ] as const) {
      const result = await call(client, name, args);
      expect(result.isError, name).toBe(true);
      expect(textOf(result), name).toMatch(/^forbidden: /);
    }
    expect(await stateOf(created.item.id)).toBe("render");
  });

  it("refuses job tokens, even the owner's, but lets them read the formats", async () => {
    const { secret } = await issueJobToken(testDb.db, {
      userId: ownerId,
      projectId,
      scopes: ["mcp:read", "mcp:write", "mcp:admin"],
    });
    const client = await connectClient(server.url, secret);
    clients.push(client);
    const created = await createPost({ format: "text", caption: "Not for jobs." });
    for (const [name, args] of [
      ["post.create", { projectId, title: "No", format: "image" }],
      ["post.compose", { itemId: created.item.id, caption: "No" }],
      [
        "post.schedule",
        { itemId: created.item.id, channelIds: [facebookId], scheduledAt: ahead(24) },
      ],
    ] as const) {
      const result = await call(client, name, args);
      expect(result.isError, name).toBe(true);
      expect(textOf(result), name).toBe("forbidden: Job tokens cannot call this tool.");
    }
    expectOk(await call(client, "post.formats", {}));
    expect(await stateOf(created.item.id)).toBe("render");
  });
});
