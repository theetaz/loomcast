import { randomUUID } from "node:crypto";
import {
  ConversationSchema,
  cursorPageSchema,
  type LiveEvent,
  MessageSchema,
  PostMessageResponseSchema,
} from "@loomcast/contracts";
import { conversations, devices, jobs, messages, projects } from "@loomcast/db";
import { createTestDb, type TestDb } from "@loomcast/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BusEventOf } from "../src/lib/bus";
import { createTokensService } from "../src/modules/tokens/service";
import { createTestApp, errorCode, insertUser, login, send, type TestApp } from "./support";

const MessagePageSchema = cursorPageSchema(MessageSchema);

let testDb: TestDb;
let t: TestApp;
let cookie: string;
let userId: string;
let live: LiveEvent[];
let enqueued: BusEventOf<"job.enqueued">[];

beforeAll(async () => {
  testDb = await createTestDb();
  t = createTestApp(testDb.db);
  live = [];
  enqueued = [];
  t.bus.subscribeLive((event) => {
    live.push(event);
  });
  t.bus.subscribe("job.enqueued", (event) => {
    enqueued.push(event);
  });
  const user = await insertUser(testDb.db);
  userId = user.id;
  ({ cookie } = await login(t.app, user.email));
});

afterAll(async () => {
  await testDb.drop();
});

async function newProject(status: "active" | "archived" = "active") {
  const [project] = await testDb.db
    .insert(projects)
    .values({
      slug: `conv-${randomUUID().slice(0, 8)}`,
      name: "Conversations",
      status,
      archivedAt: status === "archived" ? new Date() : null,
      createdBy: userId,
    })
    .returning();
  if (project === undefined) {
    throw new Error("project was not inserted");
  }
  return project;
}

async function newConversation(projectId?: string, title?: string) {
  const id = projectId ?? (await newProject()).id;
  const response = await send(t.app, "POST", `/api/projects/${id}/conversations`, {
    cookie,
    body: title === undefined ? {} : { title },
  });
  expect(response.status).toBe(201);
  return ConversationSchema.parse(await response.json());
}

async function post(conversationId: string, text: string, clientMessageId = randomUUID()) {
  return send(t.app, "POST", `/api/conversations/${conversationId}/messages`, {
    cookie,
    body: { text, clientMessageId },
  });
}

/** A paired studio agent, as the devices module will create it. */
async function newDevice() {
  const token = await createTokensService(t.deps).create({
    userId,
    kind: "device",
    name: "Studio Mac",
    scopes: ["bridge"],
  });
  const [device] = await testDb.db
    .insert(devices)
    .values({ name: "Studio Mac", platform: "darwin", tokenId: token.row.id, createdBy: userId })
    .returning();
  if (device === undefined) {
    throw new Error("device was not inserted");
  }
  return device;
}

describe("project conversations", () => {
  it("starts conversations and lists them by latest activity", async () => {
    const project = await newProject();
    const quiet = await newConversation(project.id, "Quiet");
    const busy = await newConversation(project.id, "Busy");
    const fresh = await newConversation(project.id);
    expect(busy).toMatchObject({
      projectId: project.id,
      title: "Busy",
      deviceId: null,
      createdBy: userId,
      lastMessageAt: null,
    });
    expect(fresh.title).toBeNull();

    expect((await post(quiet.id, "First")).status).toBe(201);
    expect((await post(busy.id, "Second")).status).toBe(201);

    const response = await send(t.app, "GET", `/api/projects/${project.id}/conversations`, {
      cookie,
    });
    expect(response.status).toBe(200);
    const { items } = (await response.json()) as { items: unknown[] };
    const listed = items.map((item) => ConversationSchema.parse(item));
    // Most recent message first; conversations without messages last.
    expect(listed.map((conversation) => conversation.id)).toEqual([busy.id, quiet.id, fresh.id]);
    expect(listed[0]?.lastMessageAt).not.toBeNull();
  });

  it("gets one conversation and answers 404 for unknown ids", async () => {
    const conversation = await newConversation();
    const found = await send(t.app, "GET", `/api/conversations/${conversation.id}`, { cookie });
    expect(found.status).toBe(200);
    expect(await found.json()).toEqual(conversation);

    for (const path of [
      `/api/conversations/${randomUUID()}`,
      "/api/conversations/not-an-id",
      `/api/projects/${randomUUID()}/conversations`,
    ]) {
      const response = await send(t.app, "GET", path, { cookie });
      expect(response.status, path).toBe(404);
    }
    const create = await send(t.app, "POST", `/api/projects/${randomUUID()}/conversations`, {
      cookie,
      body: {},
    });
    expect(create.status).toBe(404);
  });

  it("refuses new conversations in an archived project", async () => {
    const project = await newProject("archived");
    const response = await send(t.app, "POST", `/api/projects/${project.id}/conversations`, {
      cookie,
      body: { title: "Too late" },
    });
    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe("conflict");
  });

  it("validates the title", async () => {
    const project = await newProject();
    const response = await send(t.app, "POST", `/api/projects/${project.id}/conversations`, {
      cookie,
      body: { title: "x".repeat(201) },
    });
    expect(response.status).toBe(400);
  });
});

describe("POST /api/conversations/:id/messages", () => {
  it("stores the message, enqueues producer.chat and publishes the message", async () => {
    const conversation = await newConversation();
    const clientMessageId = randomUUID();
    const response = await post(
      conversation.id,
      "Write a hook about Rust lifetimes",
      clientMessageId,
    );
    expect(response.status).toBe(201);
    const { message, job } = PostMessageResponseSchema.parse(await response.json());

    expect(message).toMatchObject({
      conversationId: conversation.id,
      role: "user",
      authorUserId: userId,
      clientMessageId,
      jobId: job.id,
      content: { text: "Write a hook about Rust lifetimes" },
    });
    expect(job).toMatchObject({
      type: "producer.chat",
      status: "queued",
      projectId: conversation.projectId,
      conversationId: conversation.id,
      claimedByDevice: null,
      attempt: 0,
      maxAttempts: 1,
    });

    const [row] = await testDb.db.select().from(jobs).where(eq(jobs.id, job.id));
    expect(row?.payload).toEqual({
      conversationId: conversation.id,
      projectId: conversation.projectId,
      messageId: message.id,
      text: "Write a hook about Rust lifetimes",
    });
    expect(row?.deviceAffinity).toBeNull();
    expect(row?.createdBy).toBe(userId);

    expect(live).toContainEqual({ type: "conversation.message.created", payload: { message } });
    expect(enqueued.map((event) => event.payload.jobId)).toContain(job.id);

    const [stored] = await testDb.db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversation.id));
    expect(stored?.lastMessageAt?.toISOString()).toBe(message.createdAt);
  });

  it("returns the stored message and job when a clientMessageId repeats", async () => {
    const conversation = await newConversation();
    const clientMessageId = randomUUID();
    const first = PostMessageResponseSchema.parse(
      await (await post(conversation.id, "Once", clientMessageId)).json(),
    );
    const liveBefore = live.length;
    const enqueuedBefore = enqueued.length;

    const again = await post(conversation.id, "Once, but sent twice", clientMessageId);
    expect(again.status).toBe(201);
    const second = PostMessageResponseSchema.parse(await again.json());
    expect(second.message).toEqual(first.message);
    expect(second.job.id).toBe(first.job.id);

    const parallel = await Promise.all(
      Array.from({ length: 4 }, () => post(conversation.id, "Once", clientMessageId)),
    );
    for (const response of parallel) {
      expect(response.status).toBe(201);
    }

    const stored = await testDb.db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversation.id));
    expect(stored).toHaveLength(1);
    const queued = await testDb.db
      .select()
      .from(jobs)
      .where(eq(jobs.conversationId, conversation.id));
    expect(queued).toHaveLength(1);
    expect(live).toHaveLength(liveBefore);
    expect(enqueued).toHaveLength(enqueuedBefore);
  });

  it("gives parallel posts with distinct ids their own messages and jobs", async () => {
    const conversation = await newConversation();
    const responses = await Promise.all(
      Array.from({ length: 4 }, (_, index) => post(conversation.id, `Message ${index}`)),
    );
    const bodies = await Promise.all(
      responses.map(async (response) => PostMessageResponseSchema.parse(await response.json())),
    );
    expect(new Set(bodies.map((body) => body.job.id)).size).toBe(4);
    expect(new Set(bodies.map((body) => body.message.id)).size).toBe(4);
  });

  it("carries the stored producer session id and pins the job to its studio agent", async () => {
    const conversation = await newConversation();
    const device = await newDevice();
    const sessionId = `session-${randomUUID()}`;
    await testDb.db
      .update(conversations)
      .set({ producerSessionId: sessionId, deviceId: device.id })
      .where(eq(conversations.id, conversation.id));

    const response = await post(conversation.id, "Continue where we left off");
    expect(response.status).toBe(201);
    const { message, job } = PostMessageResponseSchema.parse(await response.json());

    const [row] = await testDb.db.select().from(jobs).where(eq(jobs.id, job.id));
    expect(row?.payload).toEqual({
      conversationId: conversation.id,
      projectId: conversation.projectId,
      messageId: message.id,
      text: "Continue where we left off",
      producerSessionId: sessionId,
    });
    expect(row?.deviceAffinity).toBe(device.id);
    expect(enqueued.find((event) => event.payload.jobId === job.id)?.payload).toEqual({
      jobId: job.id,
      type: "producer.chat",
      projectId: conversation.projectId,
      deviceAffinity: device.id,
    });
  });

  it("refuses messages in an archived project but still answers a repeat", async () => {
    const project = await newProject();
    const conversation = await newConversation(project.id);
    const clientMessageId = randomUUID();
    expect((await post(conversation.id, "Before archiving", clientMessageId)).status).toBe(201);
    await testDb.db
      .update(projects)
      .set({ status: "archived", archivedAt: new Date() })
      .where(eq(projects.id, project.id));

    const refused = await post(conversation.id, "After archiving");
    expect(refused.status).toBe(409);
    expect((await post(conversation.id, "Before archiving", clientMessageId)).status).toBe(201);
    const stored = await testDb.db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversation.id));
    expect(stored).toHaveLength(1);
  });

  it("validates the body and the conversation", async () => {
    const conversation = await newConversation();
    const cases: unknown[] = [
      { text: "   ", clientMessageId: randomUUID() },
      { text: "x".repeat(20_001), clientMessageId: randomUUID() },
      { text: "Hello" },
      { text: "Hello", clientMessageId: "not-a-uuid" },
    ];
    for (const body of cases) {
      const response = await send(t.app, "POST", `/api/conversations/${conversation.id}/messages`, {
        cookie,
        body,
      });
      expect(response.status).toBe(400);
      expect(await errorCode(response)).toBe("validation_failed");
    }
    const missing = await post(randomUUID(), "Anyone there?");
    expect(missing.status).toBe(404);
  });
});

describe("GET /api/conversations/:id/messages", () => {
  async function page(conversationId: string, query = "") {
    const response = await send(
      t.app,
      "GET",
      `/api/conversations/${conversationId}/messages${query}`,
      { cookie },
    );
    return response;
  }

  it("pages through messages oldest first with a keyset cursor", async () => {
    const conversation = await newConversation();
    // Five rows inserted in one statement share created_at, so the id breaks the tie.
    await testDb.db.insert(messages).values(
      Array.from({ length: 5 }, (_, index) => ({
        conversationId: conversation.id,
        role: "user" as const,
        authorUserId: userId,
        content: { text: `Batch ${index}` },
      })),
    );
    for (const text of ["Later 1", "Later 2"]) {
      expect((await post(conversation.id, text)).status).toBe(201);
    }

    const all = MessagePageSchema.parse(await (await page(conversation.id)).json());
    expect(all.items).toHaveLength(7);
    expect(all.nextCursor).toBeNull();
    expect(all.items.slice(5).map((message) => message.content.text)).toEqual([
      "Later 1",
      "Later 2",
    ]);

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query: string = cursor === null ? "?limit=3" : `?limit=3&cursor=${cursor}`;
      const response = await page(conversation.id, query);
      expect(response.status).toBe(200);
      const body = MessagePageSchema.parse(await response.json());
      seen.push(...body.items.map((message) => message.id));
      cursor = body.nextCursor;
      pages += 1;
    } while (cursor !== null);
    expect(pages).toBe(3);
    expect(seen).toEqual(all.items.map((message) => message.id));

    // The last id fetches only what arrived since.
    const lastId = seen.at(-1) ?? "";
    expect(
      MessagePageSchema.parse(await (await page(conversation.id, `?cursor=${lastId}`)).json()),
    ).toEqual({ items: [], nextCursor: null });
    await post(conversation.id, "Newest");
    const since = MessagePageSchema.parse(
      await (await page(conversation.id, `?cursor=${lastId}`)).json(),
    );
    expect(since.items.map((message) => message.content.text)).toEqual(["Newest"]);
  });

  it("rejects cursors that do not belong to the conversation and bad limits", async () => {
    const conversation = await newConversation();
    const other = await newConversation();
    const posted = PostMessageResponseSchema.parse(
      await (await post(other.id, "Elsewhere")).json(),
    );
    for (const query of [
      `?cursor=${posted.message.id}`,
      `?cursor=${randomUUID()}`,
      "?cursor=garbage",
      "?limit=0",
      "?limit=101",
      "?limit=many",
    ]) {
      const response = await page(conversation.id, query);
      expect(response.status, query).toBe(400);
      expect(await errorCode(response)).toBe("validation_failed");
    }
    expect((await page(randomUUID())).status).toBe(404);
  });
});

describe("authentication", () => {
  it("requires a session on every conversation route", async () => {
    const id = randomUUID();
    const requests: [string, string, unknown?][] = [
      ["GET", `/api/projects/${id}/conversations`],
      ["POST", `/api/projects/${id}/conversations`, {}],
      ["GET", `/api/conversations/${id}`],
      ["GET", `/api/conversations/${id}/messages`],
      ["POST", `/api/conversations/${id}/messages`, { text: "Hi", clientMessageId: id }],
    ];
    for (const [method, path, body] of requests) {
      const response = await send(t.app, method, path, { body });
      expect(response.status, `${method} ${path}`).toBe(401);
    }
  });

  it("applies the CSRF guard to writes", async () => {
    const conversation = await newConversation();
    const noOrigin = await send(t.app, "POST", `/api/conversations/${conversation.id}/messages`, {
      cookie,
      body: { text: "Hi", clientMessageId: randomUUID() },
      origin: null,
    });
    expect(noOrigin.status).toBe(403);
    const crossSite = await send(
      t.app,
      "POST",
      `/api/projects/${conversation.projectId}/conversations`,
      {
        cookie,
        body: {},
        origin: "https://evil.example.test",
      },
    );
    expect(crossSite.status).toBe(403);
  });
});
