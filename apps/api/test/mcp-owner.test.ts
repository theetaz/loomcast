import { randomUUID } from "node:crypto";
import {
  CalendarListPostsOutputSchema,
  CalendarPostOutputSchema,
  ChannelListOutputSchema,
  ContentReviewOutputSchema,
  ContentSubmitForReviewOutputSchema,
  type TokenScope,
} from "@loomcast/contracts";
import {
  apiTokens,
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
import { generatePrefixedToken } from "../src/lib/crypto";
import { createOwnerTools, type McpCaller, TOOL_CALL_AUDIT_ACTION } from "../src/modules/mcp";
import {
  connectClient,
  issueJobToken,
  issueToken,
  type McpTestServer,
  startMcpTestServer,
} from "./mcp-support";
import {
  type InsertedItem,
  type ItemSpec,
  insertAsset,
  insertItem,
  type PipelineHarness,
} from "./pipeline-support";
import { insertUser, testIp } from "./support";

type CallResult = Awaited<ReturnType<Client["callTool"]>>;

const HOUR_MS = 60 * 60_000;

let testDb: TestDb;
let server: McpTestServer;
let ownerId: string;
let ownerTokenId: string;
let owner: Client;
let writer: Client;
let projectId: string;
let channelId: string;
const clients: Client[] = [];

beforeAll(async () => {
  testDb = await createTestDb();
  server = await startMcpTestServer(testDb.db);
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
    .values({ slug: `owner-${randomUUID().slice(0, 8)}`, name: "Owner", createdBy: ownerId })
    .returning();
  if (project === undefined) {
    throw new Error("project was not inserted");
  }
  projectId = project.id;
  channelId = await newChannel();
});

afterAll(async () => {
  for (const client of [owner, writer, ...clients]) {
    await client?.close();
  }
  await server?.close();
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
async function newChannel(): Promise<string> {
  const [row] = await testDb.db
    .insert(channels)
    .values({
      platform: "instagram",
      displayName: `Channel ${randomUUID().slice(0, 6)}`,
      status: "disconnected",
      dryRun: true,
    })
    .returning({ id: channels.id });
  if (row === undefined) {
    throw new Error("channel was not inserted");
  }
  return row.id;
}

/** An item inserted straight into the database, with artifacts up to `level`. */
function item(spec: Omit<ItemSpec, "projectId">): Promise<InsertedItem> {
  const h = { db: testDb.db, userId: ownerId } as unknown as PipelineHarness;
  return insertItem(h, { projectId, ...spec });
}

async function stateOf(itemId: string) {
  const [row] = await testDb.db
    .select({ state: contentItems.state })
    .from(contentItems)
    .where(eq(contentItems.id, itemId));
  return row?.state;
}

/** A time `hours` ahead of the server's clock. */
function ahead(hours: number): string {
  return new Date(server.clock.now().getTime() + hours * HOUR_MS).toISOString();
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

async function toolAudits(tool: string) {
  return testDb.db
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.action, TOOL_CALL_AUDIT_ACTION),
        eq(auditLog.targetId, tool),
        eq(auditLog.actorId, ownerTokenId),
      ),
    );
}

async function approvedItem(): Promise<string> {
  const inReview = await item({ state: "review", level: "render" });
  expectOk(
    await call(owner, "content.review", {
      itemId: inReview.itemId,
      versionId: inReview.versionId,
      decision: "approve",
    }),
  );
  return inReview.itemId;
}

async function scheduled(itemId: string, scheduledAt = ahead(24)) {
  const result = await call(owner, "calendar.schedule_post", { itemId, channelId, scheduledAt });
  expectOk(result);
  return CalendarPostOutputSchema.parse(result.structuredContent).post;
}

describe("owner publishing over MCP", () => {
  it("approves an item in review as the owner and schedules it on a channel", async () => {
    const inReview = await item({ state: "review", level: "render" });
    const reviewed = await call(owner, "content.review", {
      itemId: inReview.itemId,
      versionId: inReview.versionId,
      decision: "approve",
      comment: "Ship it.",
    });
    expectOk(reviewed);
    const decision = ContentReviewOutputSchema.parse(reviewed.structuredContent);
    expect(decision).toMatchObject({
      itemId: inReview.itemId,
      decision: "approve",
      state: "approved",
    });
    expect(textOf(reviewed)).toContain(decision.reviewId);
    expect(await stateOf(inReview.itemId)).toBe("approved");

    // The decision is the owner's, stored as a user's, and the call names the token.
    const [row] = await testDb.db.select().from(reviews).where(eq(reviews.id, decision.reviewId));
    expect(row).toMatchObject({ userId: ownerId, actorKind: "user", comment: "Ship it." });
    expect(await toolAudits("content.review")).toContainEqual(
      expect.objectContaining({
        actorKind: "token",
        data: {
          outcome: "ok",
          projectId,
          reviewId: decision.reviewId,
          itemId: inReview.itemId,
          decision: "approve",
          state: "approved",
        },
      }),
    );

    const listed = await call(owner, "channel.list", {});
    expectOk(listed);
    const { channels: all } = ChannelListOutputSchema.parse(listed.structuredContent);
    expect(all).toContainEqual(
      expect.objectContaining({ id: channelId, platform: "instagram", dryRun: true }),
    );
    expect(JSON.stringify(listed.structuredContent)).not.toContain("secret");

    const scheduledAt = ahead(24);
    const post = await scheduled(inReview.itemId, scheduledAt);
    expect(post).toMatchObject({
      itemId: inReview.itemId,
      channelId,
      versionId: inReview.versionId,
      status: "queued",
      dryRun: true,
      scheduledAt,
    });
    expect(await stateOf(inReview.itemId)).toBe("scheduled");
    const [postAudit] = await testDb.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "post.scheduled"), eq(auditLog.targetId, post.id)));
    expect(postAudit).toMatchObject({ actorKind: "user", actorId: ownerId });
    expect(await toolAudits("calendar.schedule_post")).toContainEqual(
      expect.objectContaining({
        data: { outcome: "ok", projectId, postId: post.id, itemId: inReview.itemId, channelId },
      }),
    );

    const calendar = await call(owner, "calendar.list_posts", {
      from: ahead(0),
      to: ahead(48),
      projectId,
      channelIds: [channelId],
    });
    expectOk(calendar);
    const { posts } = CalendarListPostsOutputSchema.parse(calendar.structuredContent);
    expect(posts.map((listedPost) => listedPost.id)).toContain(post.id);

    const again = await call(owner, "calendar.schedule_post", {
      itemId: inReview.itemId,
      channelId,
      scheduledAt: ahead(30),
    });
    expect(again.isError).toBe(true);
    expect(textOf(again)).toBe("conflict: This item already has a post on that channel.");
  });

  it("reschedules and cancels a post", async () => {
    const itemId = await approvedItem();
    const post = await scheduled(itemId);

    const moved = await call(owner, "calendar.reschedule_post", {
      postId: post.id,
      scheduledAt: ahead(36),
      expectedUpdatedAt: post.updatedAt,
    });
    expectOk(moved);
    const after = CalendarPostOutputSchema.parse(moved.structuredContent).post;
    expect(after).toMatchObject({ id: post.id, status: "queued", scheduledAt: ahead(36) });

    const stale = await call(owner, "calendar.reschedule_post", {
      postId: post.id,
      scheduledAt: ahead(40),
      expectedUpdatedAt: post.updatedAt,
    });
    expect(stale.isError).toBe(true);
    expect(textOf(stale)).toMatch(/^conflict: The post changed since you loaded it\./);

    const tooSoon = await call(owner, "calendar.reschedule_post", {
      postId: post.id,
      scheduledAt: ahead(0),
      expectedUpdatedAt: after.updatedAt,
    });
    expect(tooSoon.isError).toBe(true);
    expect(textOf(tooSoon)).toMatch(/^validation_failed: .*scheduledAt: /);

    const cancelled = await call(owner, "calendar.cancel_post", { postId: post.id });
    expectOk(cancelled);
    expect(CalendarPostOutputSchema.parse(cancelled.structuredContent).post.status).toBe(
      "cancelled",
    );
    expect(await stateOf(itemId)).toBe("approved");
    const [row] = await testDb.db
      .select({ status: scheduledPosts.status })
      .from(scheduledPosts)
      .where(eq(scheduledPosts.id, post.id));
    expect(row?.status).toBe("cancelled");

    const twice = await call(owner, "calendar.cancel_post", { postId: post.id });
    expect(twice.isError).toBe(true);
    expect(textOf(twice)).toMatch(/^post_not_editable: /);
  });

  it("requests changes and reports the service's refusals", async () => {
    const inReview = await item({ state: "review", level: "render" });
    const changes = await call(owner, "content.review", {
      itemId: inReview.itemId,
      versionId: inReview.versionId,
      decision: "request_changes",
      comment: "A sharper hook.",
      enqueueRevision: false,
    });
    expectOk(changes);
    expect(ContentReviewOutputSchema.parse(changes.structuredContent).state).toBe("script");

    const notInReview = await call(owner, "content.review", {
      itemId: inReview.itemId,
      versionId: inReview.versionId,
      decision: "approve",
    });
    expect(notInReview.isError).toBe(true);
    expect(textOf(notInReview)).toMatch(/^invalid_transition: /);

    const missing = await call(owner, "content.review", {
      itemId: randomUUID(),
      versionId: randomUUID(),
      decision: "approve",
    });
    expect(textOf(missing)).toBe("not_found: No content item has that id.");

    const notApproved = await item({ state: "voice", level: "voice" });
    const early = await call(owner, "calendar.schedule_post", {
      itemId: notApproved.itemId,
      channelId,
      scheduledAt: ahead(24),
    });
    expect(early.isError).toBe(true);
    expect(textOf(early)).toMatch(/^invalid_transition: /);
  });

  it("refuses tokens without mcp:admin, so ordinary tokens never approve or schedule", async () => {
    const inReview = await item({ state: "review", level: "render" });
    const itemId = await approvedItem();
    for (const [name, args] of [
      [
        "content.review",
        { itemId: inReview.itemId, versionId: inReview.versionId, decision: "approve" },
      ],
      ["channel.list", {}],
      ["calendar.list_posts", { from: ahead(0), to: ahead(24) }],
      ["calendar.schedule_post", { itemId, channelId, scheduledAt: ahead(24) }],
      ["calendar.cancel_post", { postId: randomUUID() }],
    ] as const) {
      const result = await call(writer, name, args);
      expect(result.isError, name).toBe(true);
      expect(textOf(result), name).toMatch(/^forbidden: .*mcp:admin/);
    }
    expect(await stateOf(inReview.itemId)).toBe("review");
    expect(await stateOf(itemId)).toBe("approved");
  });

  it("refuses an admin who is not the owner", async () => {
    const admin = await insertUser(testDb.db, { role: "admin" });
    const client = await connectClient(
      server.url,
      await storedToken(admin.id, ["mcp:read", "mcp:write", "mcp:admin"]),
    );
    clients.push(client);
    const inReview = await item({ state: "review", level: "render" });
    const result = await call(client, "content.review", {
      itemId: inReview.itemId,
      versionId: inReview.versionId,
      decision: "approve",
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/^forbidden: .*mcp:admin/);

    // The tools check the owner themselves too, whatever scopes the caller carries.
    const tools = createOwnerTools({
      content: { getItem: async () => null },
      reviews: {
        create: () => {
          throw new Error("must not be called");
        },
      },
      calendar: {
        get: () => {
          throw new Error("must not be called");
        },
        create: () => {
          throw new Error("must not be called");
        },
        plan: () => {
          throw new Error("must not be called");
        },
        reschedule: () => {
          throw new Error("must not be called");
        },
        cancel: () => {
          throw new Error("must not be called");
        },
      },
      listChannels: () => {
        throw new Error("must not be called");
      },
    });
    const caller: McpCaller = {
      token: {
        id: randomUUID(),
        kind: "mcp",
        name: "admin token",
        scopes: ["mcp:read", "mcp:write", "mcp:admin"],
        user: { id: admin.id, email: admin.email, name: admin.name, role: "admin" },
      },
      boundProjectId: null,
      jobId: null,
      ip: testIp(5),
    };
    const inputs: Record<string, Record<string, unknown>> = {
      "content.review": {
        itemId: inReview.itemId,
        versionId: inReview.versionId,
        decision: "approve",
      },
      "channel.list": {},
      "calendar.list_posts": { from: ahead(0), to: ahead(24) },
      "calendar.schedule_post": { itemId: inReview.itemId, channelId, scheduledAt: ahead(24) },
      "calendar.reschedule_post": {
        postId: randomUUID(),
        scheduledAt: ahead(24),
        expectedUpdatedAt: ahead(0),
      },
      "calendar.cancel_post": { postId: randomUUID() },
    };
    expect(tools.map((tool) => tool.contract.name).sort()).toEqual(Object.keys(inputs).sort());
    for (const tool of tools) {
      const direct = await tool.run(inputs[tool.contract.name], {
        caller,
        logger: server.deps.logger,
        db: testDb.db,
      });
      expect(direct.isError, tool.contract.name).toBe(true);
      expect(textOf(direct as CallResult), tool.contract.name).toMatch(
        /^forbidden: Only the owner can /,
      );
    }
    expect(await stateOf(inReview.itemId)).toBe("review");
  });

  it("refuses job tokens, even the owner's", async () => {
    const { secret } = await issueJobToken(testDb.db, {
      userId: ownerId,
      projectId,
      scopes: ["mcp:read", "mcp:write", "mcp:admin"],
    });
    const client = await connectClient(server.url, secret);
    clients.push(client);
    const inReview = await item({ state: "review", level: "render" });
    for (const [name, args] of [
      [
        "content.review",
        { itemId: inReview.itemId, versionId: inReview.versionId, decision: "approve" },
      ],
      ["channel.list", {}],
      ["calendar.schedule_post", { itemId: inReview.itemId, channelId, scheduledAt: ahead(24) }],
    ] as const) {
      const result = await call(client, name, args);
      expect(result.isError, name).toBe(true);
      expect(textOf(result), name).toBe("forbidden: Job tokens cannot call this tool.");
    }
    expect(await stateOf(inReview.itemId)).toBe("review");
  });

  it("still never approves through content.submit_for_review", async () => {
    const voiced = await item({ state: "voice", level: "voice" });
    const renderAssetId = await insertAsset(testDb.db, {
      projectId,
      itemId: voiced.itemId,
      kind: "render",
      durationMs: 31_000,
    });
    const posterAssetId = await insertAsset(testDb.db, {
      projectId,
      itemId: voiced.itemId,
      kind: "poster",
    });
    // Even the owner's admin token only submits; the approval is a separate, explicit decision.
    const result = await call(owner, "content.submit_for_review", {
      itemId: voiced.itemId,
      baseVersionId: voiced.versionId,
      renderAssetId,
      posterAssetId,
    });
    expectOk(result);
    expect(ContentSubmitForReviewOutputSchema.parse(result.structuredContent).state).toBe("review");
    expect(await stateOf(voiced.itemId)).toBe("review");
  });
});
