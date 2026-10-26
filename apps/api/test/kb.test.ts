import { randomUUID } from "node:crypto";
import http from "node:http";
import https from "node:https";
import {
  cursorPageSchema,
  KB_SNIPPET_MATCH_START,
  KbEntryDetailSchema,
  KbEntrySchema,
  KbSearchHitSchema,
  KbTagCountSchema,
  type LiveEvent,
  listSchema,
} from "@loomcast/contracts";
import {
  auditLog,
  conversations,
  kbEntries,
  kbReferences,
  messages,
  workspaces,
} from "@loomcast/db";
import { createTestDb, type TestDb } from "@loomcast/db/testing";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createJobsService } from "../src/modules/jobs";
import { createKbService, type KbActor, normalizeTag } from "../src/modules/kb";
import { createWorkspacesService } from "../src/modules/workspaces";
import { insertAsset, sampleAnalysis } from "./kb-support";
import { createTestApp, errorCode, insertUser, login, send, type TestApp } from "./support";

const EntryPageSchema = cursorPageSchema(KbEntrySchema);
const TagListSchema = listSchema(KbTagCountSchema);
const SearchResultSchema = listSchema(KbSearchHitSchema);

let testDb: TestDb;
let t: TestApp;
let cookie: string;
let userId: string;
let live: LiveEvent[];

beforeAll(async () => {
  testDb = await createTestDb();
  t = createTestApp(testDb.db);
  live = [];
  t.bus.subscribeLive((event) => {
    live.push(event);
  });
  const user = await insertUser(testDb.db);
  userId = user.id;
  ({ cookie } = await login(t.app, user.email));
});

afterAll(async () => {
  await testDb.drop();
});

async function newWorkspace(status: "active" | "archived" = "active") {
  const [workspace] = await testDb.db
    .insert(workspaces)
    .values({
      slug: `kb-${randomUUID().slice(0, 8)}`,
      name: "Knowledge",
      status,
      archivedAt: status === "archived" ? new Date() : null,
      createdBy: userId,
    })
    .returning();
  if (workspace === undefined) {
    throw new Error("workspace was not inserted");
  }
  return workspace;
}

function kbService() {
  return createKbService({
    db: testDb.db,
    bus: t.bus,
    jobs: createJobsService({ db: testDb.db, bus: t.bus }),
  });
}

async function createEntry(workspaceId: string, body: unknown) {
  const response = await send(t.app, "POST", `/api/workspaces/${workspaceId}/kb`, { cookie, body });
  return response;
}

async function created(workspaceId: string, body: unknown) {
  const response = await createEntry(workspaceId, body);
  expect(response.status, await response.clone().text()).toBe(201);
  return KbEntryDetailSchema.parse(await response.json());
}

async function getEntry(id: string) {
  const response = await send(t.app, "GET", `/api/kb/${id}`, { cookie });
  expect(response.status).toBe(200);
  return KbEntryDetailSchema.parse(await response.json());
}

function eventsFor(entryId: string) {
  return live.filter(
    (event) =>
      (event.type === "kb.entry.created" || event.type === "kb.entry.updated"
        ? event.payload.entry.id
        : event.type === "kb.entry.deleted"
          ? event.payload.entryId
          : null) === entryId,
  );
}

async function auditActions(entryId: string) {
  const rows = await testDb.db
    .select({ action: auditLog.action, actorKind: auditLog.actorKind })
    .from(auditLog)
    .where(and(eq(auditLog.targetType, "kb_entry"), eq(auditLog.targetId, entryId)))
    .orderBy(auditLog.id);
  return rows.map((row) => row.action);
}

describe("tags", () => {
  it("normalises tags to lowercase kebab-case", () => {
    expect(normalizeTag("  Rust Lang ")).toBe("rust-lang");
    expect(normalizeTag("snake_case")).toBe("snake-case");
    expect(normalizeTag("Café!")).toBe("cafe");
    expect(normalizeTag("--a--b--")).toBe("a-b");
  });
});

describe("entries", () => {
  it("creates, reads, updates and deletes a brainstorm", async () => {
    const workspace = await newWorkspace();
    const entry = await created(workspace.id, {
      kind: "brainstorm",
      title: "Hooks for a Rust short",
      bodyMd: "Open on a compiler error.",
      tags: ["Rust Lang", "hooks", "rust_lang"],
    });
    expect(entry).toMatchObject({
      kind: "brainstorm",
      workspaceId: workspace.id,
      tags: ["rust-lang", "hooks"],
      createdVia: "ui",
      createdBy: userId,
      conversationId: null,
      reference: null,
    });
    expect(entry).not.toHaveProperty("search");
    expect(await getEntry(entry.id)).toEqual(entry);

    const patched = await send(t.app, "PATCH", `/api/kb/${entry.id}`, {
      cookie,
      body: { expectedUpdatedAt: entry.updatedAt, title: "Better hooks", tags: ["Rust"] },
    });
    expect(patched.status).toBe(200);
    const updated = KbEntryDetailSchema.parse(await patched.json());
    expect(updated).toMatchObject({ title: "Better hooks", tags: ["rust"] });
    expect(Date.parse(updated.updatedAt)).toBeGreaterThan(Date.parse(entry.updatedAt));

    const deleted = await send(t.app, "DELETE", `/api/kb/${entry.id}`, { cookie });
    expect(deleted.status).toBe(204);
    expect((await send(t.app, "GET", `/api/kb/${entry.id}`, { cookie })).status).toBe(404);
    expect((await send(t.app, "DELETE", `/api/kb/${entry.id}`, { cookie })).status).toBe(404);

    expect(eventsFor(entry.id).map((event) => event.type)).toEqual([
      "kb.entry.created",
      "kb.entry.updated",
      "kb.entry.deleted",
    ]);
    expect(await auditActions(entry.id)).toEqual([
      "kb.entry.create",
      "kb.entry.update",
      "kb.entry.delete",
    ]);
  });

  it("creates a note", async () => {
    const workspace = await newWorkspace();
    const entry = await created(workspace.id, {
      kind: "note",
      title: "Narration style",
      bodyMd: "Second person, present tense.",
    });
    expect(entry).toMatchObject({ kind: "note", tags: [], data: {} });
  });

  it("creates a decision and supersedes it in one step", async () => {
    const workspace = await newWorkspace();
    const first = await created(workspace.id, {
      kind: "decision",
      title: "Shorts run 30 seconds",
      decision: "Every short runs 30 seconds.",
      rationale: "Completion rates.",
    });
    expect(first.data).toEqual({
      decision: "Every short runs 30 seconds.",
      rationale: "Completion rates.",
      status: "active",
    });

    const second = await created(workspace.id, {
      kind: "decision",
      title: "Shorts run 25 to 45 seconds",
      decision: "Target 25 to 45 seconds.",
      supersedes: first.id,
    });
    expect(second.data).toMatchObject({ status: "active", supersedes: first.id });
    const old = await getEntry(first.id);
    expect(old.data).toMatchObject({ status: "superseded", supersededBy: second.id });
    expect(eventsFor(first.id).map((event) => event.type)).toEqual([
      "kb.entry.created",
      "kb.entry.updated",
    ]);

    // A superseded decision cannot be superseded again.
    const again = await createEntry(workspace.id, {
      kind: "decision",
      title: "Another",
      decision: "Something else.",
      supersedes: first.id,
    });
    expect(again.status).toBe(409);

    // Only decisions of the same workspace can be superseded.
    const other = await newWorkspace();
    const elsewhere = await createEntry(other.id, {
      kind: "decision",
      title: "Elsewhere",
      decision: "Something else.",
      supersedes: second.id,
    });
    expect(elsewhere.status).toBe(400);
    expect(await errorCode(elsewhere)).toBe("validation_failed");
  });

  it("updates decision fields and rejects fields of another kind", async () => {
    const workspace = await newWorkspace();
    const decision = await created(workspace.id, {
      kind: "decision",
      title: "Captions",
      decision: "Burn in captions.",
      rationale: "Sound off.",
    });
    const response = await send(t.app, "PATCH", `/api/kb/${decision.id}`, {
      cookie,
      body: { expectedUpdatedAt: decision.updatedAt, rationale: null, status: "superseded" },
    });
    expect(response.status).toBe(200);
    const updated = KbEntryDetailSchema.parse(await response.json());
    expect(updated.data).toEqual({ decision: "Burn in captions.", status: "superseded" });

    const wrongKind = await send(t.app, "PATCH", `/api/kb/${decision.id}`, {
      cookie,
      body: { expectedUpdatedAt: updated.updatedAt, likedReason: "Nice" },
    });
    expect(wrongKind.status).toBe(400);
    expect(await errorCode(wrongKind)).toBe("validation_failed");

    const note = await created(workspace.id, { kind: "note", title: "N", bodyMd: "B" });
    const decisionField = await send(t.app, "PATCH", `/api/kb/${note.id}`, {
      cookie,
      body: { expectedUpdatedAt: note.updatedAt, decision: "No" },
    });
    expect(decisionField.status).toBe(400);
  });

  it("answers 409 to an update based on a stale updatedAt, even within one millisecond", async () => {
    const workspace = await newWorkspace();
    const entry = await created(workspace.id, { kind: "note", title: "Draft", bodyMd: "One" });

    const [first, second] = await Promise.all([
      send(t.app, "PATCH", `/api/kb/${entry.id}`, {
        cookie,
        body: { expectedUpdatedAt: entry.updatedAt, bodyMd: "Two" },
      }),
      send(t.app, "PATCH", `/api/kb/${entry.id}`, {
        cookie,
        body: { expectedUpdatedAt: entry.updatedAt, bodyMd: "Three" },
      }),
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 409]);
    const conflicted = first.status === 409 ? first : second;
    const body = (await conflicted.json()) as { error: { code: string; details: unknown } };
    expect(body.error.code).toBe("conflict");
    expect(body.error.details).toMatchObject({ reason: "stale" });

    const current = await getEntry(entry.id);
    expect(["Two", "Three"]).toContain(current.bodyMd);
    const stale = await send(t.app, "PATCH", `/api/kb/${entry.id}`, {
      cookie,
      body: { expectedUpdatedAt: entry.updatedAt, bodyMd: "Four" },
    });
    expect(stale.status).toBe(409);
  });

  it("validates input and answers 404 for unknown workspaces and entries", async () => {
    const workspace = await newWorkspace();
    const invalid = await createEntry(workspace.id, { kind: "brainstorm", title: "", bodyMd: "x" });
    expect(invalid.status).toBe(400);
    const sessionSummary = await createEntry(workspace.id, {
      kind: "session_summary",
      title: "Not through the web app",
      bodyMd: "x",
    });
    expect(sessionSummary.status).toBe(400);

    const unknown = await createEntry(randomUUID(), { kind: "note", title: "N", bodyMd: "B" });
    expect(unknown.status).toBe(404);
    expect((await send(t.app, "GET", `/api/kb/${randomUUID()}`, { cookie })).status).toBe(404);
    expect((await send(t.app, "GET", "/api/kb/not-a-uuid", { cookie })).status).toBe(404);
    expect(
      (await send(t.app, "GET", `/api/workspaces/${randomUUID()}/kb`, { cookie })).status,
    ).toBe(404);
  });

  it("refuses new entries in an archived workspace", async () => {
    const workspace = await newWorkspace("archived");
    const response = await createEntry(workspace.id, { kind: "note", title: "N", bodyMd: "B" });
    expect(response.status).toBe(409);
  });

  it("requires a session and passes the CSRF check", async () => {
    const workspace = await newWorkspace();
    const body = { kind: "note", title: "N", bodyMd: "B" };
    const anonymous = await send(t.app, "POST", `/api/workspaces/${workspace.id}/kb`, { body });
    expect(anonymous.status).toBe(401);
    expect((await send(t.app, "GET", `/api/workspaces/${workspace.id}/kb`)).status).toBe(401);
    expect((await send(t.app, "GET", "/api/kb/search?q=hook")).status).toBe(401);
    const crossSite = await send(t.app, "POST", `/api/workspaces/${workspace.id}/kb`, {
      cookie,
      body,
      origin: "https://evil.example.test",
    });
    expect(crossSite.status).toBe(403);
    const entry = await created(workspace.id, body);
    for (const [method, path] of [
      ["PATCH", `/api/kb/${entry.id}`],
      ["DELETE", `/api/kb/${entry.id}`],
      ["POST", `/api/kb/${entry.id}/analyze`],
      ["POST", `/api/workspaces/${workspace.id}/kb/capture`],
    ] as const) {
      const response = await send(t.app, method, path, {
        cookie,
        body: { expectedUpdatedAt: entry.updatedAt, title: "x" },
        origin: "https://evil.example.test",
      });
      expect(response.status, `${method} ${path}`).toBe(403);
    }
  });
});

describe("listing", () => {
  it("pages newest first with a keyset cursor and filters by kind and tag", async () => {
    const workspace = await newWorkspace();
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const entry = await created(workspace.id, {
        kind: i % 2 === 0 ? "note" : "brainstorm",
        title: `Entry ${i}`,
        bodyMd: "Body",
        tags: i < 3 ? ["early"] : ["late"],
      });
      ids.push(entry.id);
    }
    // Same updated_at for every row: the id breaks ties and no row is skipped or repeated.
    await testDb.db
      .update(kbEntries)
      .set({ updatedAt: new Date("2026-10-01T00:00:00.000Z") })
      .where(eq(kbEntries.workspaceId, workspace.id));

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const query: string = cursor === null ? "limit=2" : `limit=2&cursor=${cursor}`;
      const response = await send(t.app, "GET", `/api/workspaces/${workspace.id}/kb?${query}`, {
        cookie,
      });
      expect(response.status).toBe(200);
      const page = EntryPageSchema.parse(await response.json());
      expect(page.items.length).toBeLessThanOrEqual(2);
      seen.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;
    } while (cursor !== null);
    expect(seen).toEqual([...ids].sort().reverse());

    const notes = EntryPageSchema.parse(
      await (
        await send(t.app, "GET", `/api/workspaces/${workspace.id}/kb?kinds=note`, { cookie })
      ).json(),
    );
    expect(notes.items.map((item) => item.kind)).toEqual(["note", "note", "note"]);
    const both = EntryPageSchema.parse(
      await (
        await send(t.app, "GET", `/api/workspaces/${workspace.id}/kb?kinds=note&kinds=brainstorm`, {
          cookie,
        })
      ).json(),
    );
    expect(both.items).toHaveLength(5);
    const late = EntryPageSchema.parse(
      await (
        await send(t.app, "GET", `/api/workspaces/${workspace.id}/kb?tag=late`, { cookie })
      ).json(),
    );
    expect(late.items.map((item) => item.title).sort()).toEqual(["Entry 3", "Entry 4"]);

    const badCursor = await send(t.app, "GET", `/api/workspaces/${workspace.id}/kb?cursor=nope`, {
      cookie,
    });
    expect(badCursor.status).toBe(400);
  });

  it("counts tags of live entries, most used first", async () => {
    const workspace = await newWorkspace();
    await created(workspace.id, { kind: "note", title: "A", bodyMd: "", tags: ["hooks", "rust"] });
    await created(workspace.id, { kind: "note", title: "B", bodyMd: "", tags: ["hooks"] });
    const gone = await created(workspace.id, {
      kind: "note",
      title: "C",
      bodyMd: "",
      tags: ["gone"],
    });
    await send(t.app, "DELETE", `/api/kb/${gone.id}`, { cookie });

    const response = await send(t.app, "GET", `/api/workspaces/${workspace.id}/kb/tags`, {
      cookie,
    });
    expect(response.status).toBe(200);
    expect(TagListSchema.parse(await response.json()).items).toEqual([
      { tag: "hooks", count: 2 },
      { tag: "rust", count: 1 },
    ]);
  });
});

describe("capture", () => {
  async function conversationWithMessages() {
    const workspace = await newWorkspace();
    const [conversation] = await testDb.db
      .insert(conversations)
      .values({ workspaceId: workspace.id, createdBy: userId, title: "Chat" })
      .returning();
    if (conversation === undefined) {
      throw new Error("conversation was not inserted");
    }
    const base = Date.parse("2026-10-13T10:00:00.000Z");
    const rows = await testDb.db
      .insert(messages)
      .values(
        [
          { role: "user", text: "Give me hooks about DNS", at: 0 },
          { role: "assistant", text: "A relay of librarians.", at: 1_000 },
          { role: "event", text: "Tool ran", at: 1_500 },
          { role: "user", text: "Shorter please", at: 2_000 },
          { role: "assistant", text: "Librarian relay.", at: 3_000 },
        ].map((message) => ({
          conversationId: conversation.id,
          role: message.role as "user" | "assistant" | "event",
          authorUserId: message.role === "user" ? userId : null,
          content: { text: message.text },
          createdAt: new Date(base + message.at),
        })),
      )
      .returning();
    return { workspace, conversation, rows };
  }

  it("builds markdown from the selected messages in the order they were posted", async () => {
    const { workspace, conversation, rows } = await conversationWithMessages();
    const [ask, answer, , shorter, final] = rows;
    if (ask === undefined || answer === undefined || shorter === undefined || final === undefined) {
      throw new Error("messages were not inserted");
    }
    const response = await send(t.app, "POST", `/api/workspaces/${workspace.id}/kb/capture`, {
      cookie,
      body: {
        conversationId: conversation.id,
        // Selected out of order: the entry follows the conversation.
        messageIds: [final.id, ask.id, answer.id, shorter.id],
        title: "DNS hooks",
        kind: "brainstorm",
        tags: ["DNS"],
      },
    });
    expect(response.status).toBe(201);
    const entry = KbEntryDetailSchema.parse(await response.json());
    expect(entry.bodyMd).toBe(
      [
        "**You:**\nGive me hooks about DNS",
        "**Producer:**\nA relay of librarians.",
        "**You:**\nShorter please",
        "**Producer:**\nLibrarian relay.",
      ].join("\n\n"),
    );
    expect(entry).toMatchObject({
      kind: "brainstorm",
      conversationId: conversation.id,
      createdVia: "ui",
      tags: ["dns"],
      data: { messageIds: [ask.id, answer.id, shorter.id, final.id] },
    });
  });

  it("rejects messages of another conversation and non-chat messages", async () => {
    const { workspace, conversation, rows } = await conversationWithMessages();
    const other = await conversationWithMessages();
    const foreign = other.rows[0];
    const event = rows[2];
    if (foreign === undefined || event === undefined) {
      throw new Error("messages were not inserted");
    }
    const path = `/api/workspaces/${workspace.id}/kb/capture`;
    const base = { conversationId: conversation.id, title: "T", kind: "note" };
    const wrongConversation = await send(t.app, "POST", path, {
      cookie,
      body: { ...base, messageIds: [foreign.id] },
    });
    expect(wrongConversation.status).toBe(400);
    const nonChat = await send(t.app, "POST", path, {
      cookie,
      body: { ...base, messageIds: [event.id] },
    });
    expect(nonChat.status).toBe(400);
    const wrongWorkspace = await send(
      t.app,
      "POST",
      `/api/workspaces/${other.workspace.id}/kb/capture`,
      {
        cookie,
        body: { ...base, messageIds: [event.id] },
      },
    );
    expect(wrongWorkspace.status).toBe(404);
  });
});

describe("references", () => {
  it("normalises the URL, detects the platform and never fetches it", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const spies = [
      vi.spyOn(http, "request"),
      vi.spyOn(http, "get"),
      vi.spyOn(https, "request"),
      vi.spyOn(https, "get"),
    ];
    try {
      const workspace = await newWorkspace();
      const entry = await created(workspace.id, {
        kind: "reference",
        url: "https://www.instagram.com/reel/KbSample01/?igsh=abc&utm_source=share",
        author: "sample.creator",
        likedReason: "The diagram builds with the voice.",
        transcript: "A request comes in and the cache answers first.",
        tags: ["Pacing"],
      });
      expect(entry).toMatchObject({
        kind: "reference",
        title: "Instagram reference by sample.creator",
        sourceUrl: "https://instagram.com/reel/KbSample01/",
        tags: ["pacing"],
        data: {},
        reference: {
          url: "https://instagram.com/reel/KbSample01/",
          platform: "instagram",
          author: "sample.creator",
          likedReason: "The diagram builds with the voice.",
          transcript: "A request comes in and the cache answers first.",
          analysis: null,
          analysisStatus: "none",
          analysisJobId: null,
          analyzedAt: null,
        },
      });
      expect(await getEntry(entry.id)).toEqual(entry);
      expect(fetchSpy).not.toHaveBeenCalled();
      for (const spy of spies) {
        expect(spy).not.toHaveBeenCalled();
      }
    } finally {
      fetchSpy.mockRestore();
      for (const spy of spies) {
        spy.mockRestore();
      }
    }
  });

  it("answers 409 with the existing id for a URL already saved in the workspace", async () => {
    const workspace = await newWorkspace();
    const first = await created(workspace.id, {
      kind: "reference",
      url: "https://youtu.be/KbSample02?si=tracking",
      title: "Question hook",
    });
    expect(first.reference?.platform).toBe("youtube");

    const duplicate = await createEntry(workspace.id, {
      kind: "reference",
      url: "  https://youtu.be/KbSample02?si=other  ",
    });
    expect(duplicate.status).toBe(409);
    const body = (await duplicate.json()) as { error: { code: string; details: unknown } };
    expect(body.error).toMatchObject({
      code: "conflict",
      details: { reason: "duplicate", entryId: first.id },
    });

    // Another workspace may save the same link, and deleting the entry frees the URL.
    const other = await newWorkspace();
    await created(other.id, { kind: "reference", url: "https://youtu.be/KbSample02" });
    await send(t.app, "DELETE", `/api/kb/${first.id}`, { cookie });
    const again = await created(workspace.id, {
      kind: "reference",
      url: "https://youtu.be/KbSample02",
    });
    expect(again.title).toBe("YouTube reference");
  });

  it("rejects links that are not http or https", async () => {
    const workspace = await newWorkspace();
    const response = await createEntry(workspace.id, {
      kind: "reference",
      url: "ftp://example.test/a",
    });
    expect(response.status).toBe(400);
  });

  it("updates reference fields and keeps the URL", async () => {
    const workspace = await newWorkspace();
    const entry = await created(workspace.id, {
      kind: "reference",
      url: "https://www.tiktok.com/@sample/video/1000000000000000009",
      author: "sample",
    });
    const response = await send(t.app, "PATCH", `/api/kb/${entry.id}`, {
      cookie,
      body: {
        expectedUpdatedAt: entry.updatedAt,
        author: null,
        likedReason: "Jump cuts",
        transcript: "Each key becomes a number called the bucket.",
      },
    });
    expect(response.status).toBe(200);
    const updated = KbEntryDetailSchema.parse(await response.json());
    expect(updated.reference).toMatchObject({
      url: entry.sourceUrl,
      author: null,
      likedReason: "Jump cuts",
      transcript: "Each key becomes a number called the bucket.",
    });
    const [row] = await testDb.db
      .select({ searchExtra: kbEntries.searchExtra })
      .from(kbEntries)
      .where(eq(kbEntries.id, entry.id));
    expect(row?.searchExtra).toBe("Jump cuts\nEach key becomes a number called the bucket.");

    const urlChange = await send(t.app, "PATCH", `/api/kb/${entry.id}`, {
      cookie,
      body: { expectedUpdatedAt: updated.updatedAt, url: "https://example.test/other" },
    });
    // `url` is not an updatable field, so only the expected timestamp remains: nothing to update.
    expect(urlChange.status).toBe(400);
  });

  it("indexes the first 20k transcript characters and the analysis takeaways", async () => {
    const workspace = await newWorkspace();
    const kb = kbService();
    const actor: KbActor = { kind: "user", id: userId, userId, via: "mcp" };
    const transcript = `${"word ".repeat(4_000)}${"tail ".repeat(2_000)}`;
    const entry = await kb.create(
      workspace.id,
      {
        kind: "reference",
        url: "https://threads.net/@sample/post/KbSample03",
        transcript,
        analysis: sampleAnalysis("Dim everything but one line"),
      },
      actor,
    );
    expect(entry.createdVia).toBe("mcp");
    expect(entry.reference).toMatchObject({ analysisStatus: "done" });
    expect(entry.reference?.analyzedAt).not.toBeNull();
    const [row] = await testDb.db
      .select({ searchExtra: kbEntries.searchExtra })
      .from(kbEntries)
      .where(eq(kbEntries.id, entry.id));
    expect(row?.searchExtra).toBe(`${transcript.slice(0, 20_000)}\nDim everything but one line`);
    const [reference] = await testDb.db
      .select({ transcript: kbReferences.transcript })
      .from(kbReferences)
      .where(eq(kbReferences.entryId, entry.id));
    expect(reference?.transcript).toBe(transcript);
  });
});

describe("reference media", () => {
  it("attaches only a ready reference_media asset of the same workspace", async () => {
    const workspace = await newWorkspace();
    const other = await newWorkspace();
    const media = await insertAsset(testDb.db, workspace.id);
    const entry = await created(workspace.id, {
      kind: "reference",
      url: "https://www.facebook.com/reel/1000000000000000042",
      mediaAssetId: media,
    });
    expect(entry.reference).toMatchObject({ mediaAssetId: media, transcript: null });

    for (const assetId of [
      await insertAsset(testDb.db, other.id),
      await insertAsset(testDb.db, workspace.id, { status: "pending" }),
      await insertAsset(testDb.db, workspace.id, { kind: "poster" }),
      randomUUID(),
    ]) {
      const response = await createEntry(workspace.id, {
        kind: "reference",
        url: `https://example.test/watch/${randomUUID()}`,
        mediaAssetId: assetId,
      });
      expect(response.status).toBe(400);
      expect(await errorCode(response)).toBe("validation_failed");
    }

    const cleared = await send(t.app, "PATCH", `/api/kb/${entry.id}`, {
      cookie,
      body: { expectedUpdatedAt: entry.updatedAt, mediaAssetId: null },
    });
    expect(cleared.status).toBe(200);
    const updated = KbEntryDetailSchema.parse(await cleared.json());
    expect(updated.reference?.mediaAssetId).toBeNull();
    const pending = await insertAsset(testDb.db, workspace.id, { status: "pending" });
    const refused = await send(t.app, "PATCH", `/api/kb/${entry.id}`, {
      cookie,
      body: { expectedUpdatedAt: updated.updatedAt, mediaAssetId: pending },
    });
    expect(refused.status).toBe(400);
  });
});

describe("session summaries", () => {
  it("upserts one entry per session", async () => {
    const workspace = await newWorkspace();
    const kb = kbService();
    const actor: KbActor = { kind: "user", id: userId, userId, via: "hook" };
    const first = await kb.saveSessionSummary(
      workspace.id,
      { sessionId: "session-kb-1", summaryMd: "# Drafted the DNS script\nMore.", cwd: "/tmp/x" },
      actor,
    );
    expect(first.created).toBe(true);
    expect(first.entry).toMatchObject({
      kind: "session_summary",
      title: "Session summary: Drafted the DNS script",
      createdVia: "hook",
      data: { sessionId: "session-kb-1", cwd: "/tmp/x" },
    });
    const second = await kb.saveSessionSummary(
      workspace.id,
      { sessionId: "session-kb-1", summaryMd: "Rewrote the hook." },
      actor,
    );
    expect(second.created).toBe(false);
    expect(second.entry.id).toBe(first.entry.id);
    expect(second.entry.bodyMd).toBe("Rewrote the hook.");
    expect(eventsFor(first.entry.id).map((event) => event.type)).toEqual([
      "kb.entry.created",
      "kb.entry.updated",
    ]);
  });
});

describe("search", () => {
  async function search(query: string) {
    const response = await send(t.app, "GET", `/api/kb/search?${query}`, { cookie });
    expect(response.status, await response.clone().text()).toBe(200);
    return SearchResultSchema.parse(await response.json()).items;
  }

  it("ranks matches within one workspace or across every workspace", async () => {
    const mine = await newWorkspace();
    const other = await newWorkspace();
    const word = `zebrahook${randomUUID().slice(0, 6)}`;
    const titled = await created(mine.id, {
      kind: "brainstorm",
      title: `The ${word} opening`,
      bodyMd: "Start on motion.",
    });
    const bodied = await created(mine.id, {
      kind: "note",
      title: "Patterns that worked",
      bodyMd: `A surprising number first, then the ${word} reveal.`,
    });
    const elsewhere = await created(other.id, {
      kind: "note",
      title: "Elsewhere",
      bodyMd: `The ${word} again.`,
    });
    const gone = await created(mine.id, { kind: "note", title: "Gone", bodyMd: `${word} gone` });
    await send(t.app, "DELETE", `/api/kb/${gone.id}`, { cookie });

    const scoped = await search(`q=${word}&workspaceId=${mine.id}`);
    expect(scoped.map((hit) => hit.entryId)).toEqual([titled.id, bodied.id]);
    expect(scoped.every((hit) => hit.workspaceId === mine.id)).toBe(true);
    expect(scoped[1]?.snippet).toContain(KB_SNIPPET_MATCH_START);
    expect(scoped[0]).not.toHaveProperty("search");

    const global = await search(`q=${word}`);
    expect(global.map((hit) => hit.entryId).sort()).toEqual(
      [titled.id, bodied.id, elsewhere.id].sort(),
    );

    const notes = await search(`q=${word}&kinds=note`);
    expect(notes.map((hit) => hit.entryId).sort()).toEqual([bodied.id, elsewhere.id].sort());
    const limited = await search(`q=${word}&limit=1`);
    expect(limited).toHaveLength(1);
  });

  it("finds a reference by its transcript", async () => {
    const workspace = await newWorkspace();
    const word = `quokka${randomUUID().slice(0, 6)}`;
    const entry = await created(workspace.id, {
      kind: "reference",
      url: `https://www.youtube.com/shorts/${word}`,
      transcript: `Quick: what does a ${word} do when you press enter?`,
    });
    const hits = await search(`q=${word}&workspaceId=${workspace.id}`);
    expect(hits.map((hit) => hit.entryId)).toEqual([entry.id]);
  });

  it("validates the query", async () => {
    expect((await send(t.app, "GET", "/api/kb/search", { cookie })).status).toBe(400);
    expect((await send(t.app, "GET", "/api/kb/search?q=a&limit=500", { cookie })).status).toBe(400);
    expect((await send(t.app, "GET", "/api/kb/search?q=a&kinds=nope", { cookie })).status).toBe(
      400,
    );
    expect(
      (await send(t.app, "GET", "/api/kb/search?q=a&workspaceId=nope", { cookie })).status,
    ).toBe(400);
  });
});

describe("workspace stats", () => {
  it("counts live knowledge base entries", async () => {
    const workspace = await newWorkspace();
    const service = createWorkspacesService({ db: testDb.db, bus: t.bus });
    expect((await service.stats(workspace.id)).kbEntries).toBe(0);
    await created(workspace.id, { kind: "note", title: "One", bodyMd: "" });
    const two = await created(workspace.id, { kind: "note", title: "Two", bodyMd: "" });
    await created(workspace.id, { kind: "reference", url: "https://example.test/watch/1" });
    await send(t.app, "DELETE", `/api/kb/${two.id}`, { cookie });
    expect(await service.stats(workspace.id)).toEqual({ conversations: 0, kbEntries: 2, items: 0 });
  });
});
