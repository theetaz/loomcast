import { randomUUID } from "node:crypto";
import {
  KB_SNIPPET_MATCH_END,
  KB_SNIPPET_MATCH_START,
  KbAddDecisionOutputSchema,
  KbAddReferenceOutputSchema,
  KbGetOutputSchema,
  KbSaveBrainstormOutputSchema,
  KbSaveSessionSummaryOutputSchema,
  KbSearchOutputSchema,
  kbTools,
  type LiveEvent,
} from "@loomcast/contracts";
import { auditLog, conversations, jobs, kbEntries, kbReferences, projects } from "@loomcast/db";
import { createTestDb, type TestDb } from "@loomcast/db/testing";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { kbEntryUrl, projectIdFromCwd, TOOL_CALL_AUDIT_ACTION } from "../src/modules/mcp";
import { createTokensService } from "../src/modules/tokens/service";
import { sampleAnalysis } from "./kb-support";
import {
  bearer,
  connectClient,
  issueJobToken,
  issueToken,
  type McpTestServer,
  rpc,
  startMcpTestServer,
} from "./mcp-support";
import { APP_ORIGIN, insertUser, login } from "./support";

type CallResult = Awaited<ReturnType<Client["callTool"]>>;

let testDb: TestDb;
let server: McpTestServer;
let userId: string;
let userEmail: string;
let writer: Client;
let writerTokenId: string;
let reader: Client;
const events: LiveEvent[] = [];
const clients: Client[] = [];

beforeAll(async () => {
  testDb = await createTestDb();
  server = await startMcpTestServer(testDb.db);
  server.deps.bus.subscribeLive((event) => {
    events.push(event);
  });
  const user = await insertUser(testDb.db);
  userId = user.id;
  userEmail = user.email;
  const write = await issueToken(server.deps, userId, ["mcp:read", "mcp:write"]);
  writerTokenId = write.row.id;
  writer = await connectClient(server.url, write.secret);
  reader = await connectClient(
    server.url,
    (await issueToken(server.deps, userId, ["mcp:read"])).secret,
  );
});

afterAll(async () => {
  for (const client of [writer, reader, ...clients]) {
    await client?.close();
  }
  await server?.close();
  await testDb?.drop();
});

async function newProject(label = "Knowledge") {
  const [project] = await testDb.db
    .insert(projects)
    .values({ slug: `mcp-kb-${randomUUID().slice(0, 8)}`, name: label, createdBy: userId })
    .returning();
  if (project === undefined) {
    throw new Error("project was not inserted");
  }
  return project;
}

async function newConversation(projectId: string): Promise<string> {
  const [conversation] = await testDb.db
    .insert(conversations)
    .values({ projectId, title: "Planning", createdBy: userId })
    .returning({ id: conversations.id });
  if (conversation === undefined) {
    throw new Error("conversation was not inserted");
  }
  return conversation.id;
}

/** A client with a job token of a running job in `projectId`, as a producer session gets one. */
async function jobClient(projectId: string, options: { conversationId?: string } = {}) {
  const issued = await issueJobToken(testDb.db, {
    userId,
    projectId,
    scopes: ["mcp:read", "mcp:write"],
  });
  if (options.conversationId !== undefined) {
    await testDb.db
      .update(jobs)
      .set({ conversationId: options.conversationId })
      .where(eq(jobs.id, issued.job.id));
  }
  const client = await connectClient(server.url, issued.secret);
  clients.push(client);
  return { client, ...issued };
}

function textOf(result: CallResult): string {
  const [first] = result.content as { type: string; text: string }[];
  return first?.text ?? "";
}

function expectOk(result: CallResult): void {
  expect(result.isError, textOf(result)).toBeFalsy();
}

async function entryRow(id: string) {
  const [row] = await testDb.db.select().from(kbEntries).where(eq(kbEntries.id, id));
  return row;
}

async function brainstorm(client: Client, projectId: string, extra: Record<string, unknown> = {}) {
  const result = await client.callTool({
    name: "kb.save_brainstorm",
    arguments: {
      projectId,
      title: "Hooks that work",
      bodyMd: "Open on the finished diagram, then rewind.",
      ...extra,
    },
  });
  expectOk(result);
  return KbSaveBrainstormOutputSchema.parse(result.structuredContent);
}

describe("kb tools", () => {
  it("lists the knowledge-base tools with their contracts", async () => {
    const { tools } = await reader.listTools();
    const kb = tools.filter((tool) => tool.name.startsWith("kb."));
    expect(kb.map((tool) => tool.name).sort()).toEqual(Object.keys(kbTools).sort());
    for (const tool of kb) {
      const contract = kbTools[tool.name as keyof typeof kbTools];
      expect(tool.description).toBe(contract.description);
      expect(tool.outputSchema?.type).toBe("object");
      expect(tool.annotations?.readOnlyHint).toBe(contract.scope === "mcp:read");
    }
  });

  it("saves a brainstorm that is stored, audited and published to the event stream", async () => {
    const project = await newProject();
    const { cookie } = await login(server.running.app, userEmail);
    const stream = await server.running.app.request("/api/stream", { headers: { Cookie: cookie } });
    expect(stream.status).toBe(200);
    const body = stream.body?.getReader();
    if (body === undefined) {
      throw new Error("the stream has no body");
    }
    const decoder = new TextDecoder();
    let received = "";
    const readUntil = async (needle: string) => {
      const deadline = Date.now() + 5_000;
      while (!received.includes(needle)) {
        if (Date.now() > deadline) {
          throw new Error(`no ${needle} on the stream`);
        }
        const chunk = await body.read();
        if (chunk.done) {
          throw new Error("the stream ended");
        }
        received += decoder.decode(chunk.value, { stream: true });
      }
    };
    // The first frame is sent once the stream is attached to the live hub.
    await readUntil("retry:");

    const output = await brainstorm(writer, project.id, {
      tags: ["Hooks", "diagrams"],
      sessionRef: "chat-42",
    });
    expect(output.url).toBe(kbEntryUrl(APP_ORIGIN, project.id, output.entryId));
    expect(output.url).toBe(`${APP_ORIGIN}/projects/${project.id}/kb/${output.entryId}`);

    await readUntil(output.entryId);
    await body.cancel();
    expect(received).toContain('"type":"kb.entry.created"');

    expect(await entryRow(output.entryId)).toMatchObject({
      projectId: project.id,
      kind: "brainstorm",
      title: "Hooks that work",
      tags: ["hooks", "diagrams"],
      data: { sessionRef: "chat-42" },
      createdBy: userId,
      createdByTokenId: writerTokenId,
      createdVia: "mcp",
      conversationId: null,
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "kb.entry.created",
        payload: { entry: expect.objectContaining({ id: output.entryId }) },
      }),
    );

    const audits = await testDb.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.actorKind, "token"), eq(auditLog.actorId, writerTokenId)));
    expect(audits).toContainEqual(
      expect.objectContaining({ action: "kb.entry.create", targetId: output.entryId }),
    );
    expect(audits).toContainEqual(
      expect.objectContaining({
        action: TOOL_CALL_AUDIT_ACTION,
        targetId: "kb.save_brainstorm",
        data: { outcome: "ok", projectId: project.id },
      }),
    );
  });

  it("marks a producer session's brainstorm and links its conversation", async () => {
    const project = await newProject();
    const conversationId = await newConversation(project.id);
    const { client, row, job } = await jobClient(project.id, { conversationId });
    const output = await brainstorm(client, project.id);
    expect(await entryRow(output.entryId)).toMatchObject({
      createdVia: "producer",
      createdByTokenId: row.id,
      conversationId,
    });

    // A job without a conversation writes an unlinked entry, into its project by default.
    const plain = await jobClient(project.id);
    const result = await plain.client.callTool({
      name: "kb.add_decision",
      arguments: { projectId: project.id, title: "Voice", decision: "Use one narrator." },
    });
    expectOk(result);
    const { entryId } = KbAddDecisionOutputSchema.parse(result.structuredContent);
    expect(await entryRow(entryId)).toMatchObject({ createdVia: "producer", conversationId: null });

    const [audit] = await testDb.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, TOOL_CALL_AUDIT_ACTION), eq(auditLog.actorId, row.id)));
    expect(audit?.data).toEqual({ outcome: "ok", projectId: project.id, jobId: job.id });
  });

  it("adds a reference without analysing it or fetching it", async () => {
    const project = await newProject();
    const url = `https://www.youtube.com/shorts/${randomUUID().slice(0, 11)}`;
    const result = await writer.callTool({
      name: "kb.add_reference",
      arguments: {
        projectId: project.id,
        url,
        author: "@builder",
        likedReason: "The diagram builds with the voice.",
        transcript: "Here is the whole idea in one picture.",
      },
    });
    expectOk(result);
    const { entryId } = KbAddReferenceOutputSchema.parse(result.structuredContent);
    expect(textOf(result)).toContain(entryId);

    const [reference] = await testDb.db
      .select()
      .from(kbReferences)
      .where(eq(kbReferences.entryId, entryId));
    expect(reference).toMatchObject({
      platform: "youtube",
      author: "@builder",
      analysisStatus: "none",
      analysis: null,
    });
    const analyses = await testDb.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.projectId, project.id), eq(jobs.type, "kb.analyze_reference")));
    expect(analyses).toEqual([]);

    // An analysis made by the caller is stored as done.
    const analysed = await writer.callTool({
      name: "kb.add_reference",
      arguments: {
        projectId: project.id,
        url: `https://www.instagram.com/reel/${randomUUID().slice(0, 10)}/`,
        analysis: sampleAnalysis(),
      },
    });
    expectOk(analysed);
    const second = KbAddReferenceOutputSchema.parse(analysed.structuredContent);
    const get = await reader.callTool({ name: "kb.get", arguments: { entryId: second.entryId } });
    expect(KbGetOutputSchema.parse(get.structuredContent).entry.reference).toMatchObject({
      platform: "instagram",
      analysisStatus: "done",
    });

    const duplicate = await writer.callTool({
      name: "kb.add_reference",
      arguments: { projectId: project.id, url },
    });
    expect(duplicate.isError).toBe(true);
    expect(textOf(duplicate)).toBe(
      `conflict: This reference is already saved in the project as entry ${entryId}.`,
    );
  });

  it("records decisions and supersedes earlier ones", async () => {
    const project = await newProject();
    const first = KbAddDecisionOutputSchema.parse(
      (
        await writer.callTool({
          name: "kb.add_decision",
          arguments: { projectId: project.id, title: "Length", decision: "Keep shorts at 45 s." },
        })
      ).structuredContent,
    );
    const result = await writer.callTool({
      name: "kb.add_decision",
      arguments: {
        projectId: project.id,
        title: "Length",
        decision: "Keep shorts at 30 s.",
        rationale: "Retention drops after 30 s.",
        supersedes: first.entryId,
        tags: ["format"],
      },
    });
    expectOk(result);
    const second = KbAddDecisionOutputSchema.parse(result.structuredContent);
    expect((await entryRow(second.entryId))?.data).toEqual({
      decision: "Keep shorts at 30 s.",
      rationale: "Retention drops after 30 s.",
      status: "active",
      supersedes: first.entryId,
    });
    expect((await entryRow(first.entryId))?.data).toMatchObject({
      status: "superseded",
      supersededBy: second.entryId,
    });

    const unknown = await writer.callTool({
      name: "kb.add_decision",
      arguments: {
        projectId: project.id,
        title: "Nope",
        decision: "Nothing to replace.",
        supersedes: randomUUID(),
      },
    });
    expect(unknown.isError).toBe(true);
    expect(textOf(unknown)).toBe(
      "validation_failed: The request is not valid. (supersedes: No decision with that id in this project)",
    );
  });

  it("searches one project or all of them", async () => {
    const word = `zebrafish${randomUUID().slice(0, 6)}`;
    const one = await newProject("One");
    const two = await newProject("Two");
    const a = await brainstorm(writer, one.id, { title: `About ${word}`, bodyMd: `${word} facts` });
    const b = await brainstorm(writer, two.id, { title: `More ${word}`, bodyMd: `${word} again` });

    const all = await reader.callTool({ name: "kb.search", arguments: { query: word } });
    expectOk(all);
    const hits = KbSearchOutputSchema.parse(all.structuredContent).hits;
    expect(hits.map((hit) => hit.entryId).sort()).toEqual([a.entryId, b.entryId].sort());
    expect(textOf(all)).toMatch(/^2 matches:/);
    expect(textOf(all)).not.toContain(KB_SNIPPET_MATCH_START);
    expect(textOf(all)).not.toContain(KB_SNIPPET_MATCH_END);

    const scoped = await reader.callTool({
      name: "kb.search",
      arguments: { query: word, projectId: one.id, kinds: ["brainstorm"], limit: 5 },
    });
    expect(KbSearchOutputSchema.parse(scoped.structuredContent).hits).toEqual([
      expect.objectContaining({ entryId: a.entryId, projectId: one.id, kind: "brainstorm" }),
    ]);

    const decisions = await reader.callTool({
      name: "kb.search",
      arguments: { query: word, kinds: ["decision"] },
    });
    expect(KbSearchOutputSchema.parse(decisions.structuredContent).hits).toEqual([]);
    expect(textOf(decisions)).toBe("No knowledge-base entries match.");

    // A job token without a project searches its own project only.
    const { client } = await jobClient(two.id);
    const bound = await client.callTool({ name: "kb.search", arguments: { query: word } });
    expect(KbSearchOutputSchema.parse(bound.structuredContent).hits.map((h) => h.entryId)).toEqual([
      b.entryId,
    ]);
  });

  it("gets an entry with its details", async () => {
    const project = await newProject();
    const { entryId } = await brainstorm(writer, project.id);
    const result = await reader.callTool({ name: "kb.get", arguments: { entryId } });
    expectOk(result);
    const { entry } = KbGetOutputSchema.parse(result.structuredContent);
    expect(entry).toMatchObject({
      id: entryId,
      projectId: project.id,
      kind: "brainstorm",
      bodyMd: "Open on the finished diagram, then rewind.",
      reference: null,
    });
    expect(textOf(result)).toContain(entryId);

    const missing = await reader.callTool({ name: "kb.get", arguments: { entryId: randomUUID() } });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toBe("not_found: No knowledge-base entry has that id.");
  });

  it("refuses writes with a read-only token", async () => {
    const project = await newProject();
    const result = await reader.callTool({
      name: "kb.save_brainstorm",
      arguments: { projectId: project.id, title: "Nope", bodyMd: "Read only." },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/^forbidden: .*mcp:write/);
  });

  it("reports unknown and archived projects", async () => {
    const missing = await writer.callTool({
      name: "kb.save_brainstorm",
      arguments: { projectId: randomUUID(), title: "Lost", bodyMd: "Nowhere." },
    });
    expect(textOf(missing)).toBe("not_found: Project not found.");

    const project = await newProject();
    await testDb.db
      .update(projects)
      .set({ status: "archived", archivedAt: new Date() })
      .where(eq(projects.id, project.id));
    const archived = await writer.callTool({
      name: "kb.save_brainstorm",
      arguments: { projectId: project.id, title: "Late", bodyMd: "Too late." },
    });
    expect(textOf(archived)).toMatch(/^conflict: The project is archived/);
  });
});

describe("kb.save_session_summary", () => {
  const sessionId = () => `session-${randomUUID()}`;

  it("saves a summary for a named project and replaces it on a second call", async () => {
    const project = await newProject();
    const id = sessionId();
    const first = await writer.callTool({
      name: "kb.save_session_summary",
      arguments: { projectId: project.id, sessionId: id, summaryMd: "# Picked a hook\nDetails." },
    });
    expectOk(first);
    const { entryId } = KbSaveSessionSummaryOutputSchema.parse(first.structuredContent);
    expect(await entryRow(entryId)).toMatchObject({
      kind: "session_summary",
      title: "Session summary: Picked a hook",
      createdVia: "hook",
      createdByTokenId: writerTokenId,
      data: { sessionId: id },
    });

    const again = await writer.callTool({
      name: "kb.save_session_summary",
      arguments: { projectId: project.id, sessionId: id, summaryMd: "Changed the hook." },
    });
    expect(KbSaveSessionSummaryOutputSchema.parse(again.structuredContent).entryId).toBe(entryId);
    expect((await entryRow(entryId))?.bodyMd).toBe("Changed the hook.");
  });

  it("finds the project from the working directory", async () => {
    const project = await newProject();
    const cwd = `/Users/someone/Loomcast/projects/${project.id}/scripts`;
    const result = await writer.callTool({
      name: "kb.save_session_summary",
      arguments: { sessionId: sessionId(), summaryMd: "Wrote the script.", cwd },
    });
    expectOk(result);
    const { entryId } = KbSaveSessionSummaryOutputSchema.parse(result.structuredContent);
    expect(await entryRow(entryId)).toMatchObject({ projectId: project.id, data: { cwd } });
  });

  it("fails with project_unresolved without a project or a project folder", async () => {
    for (const extra of [{}, { cwd: "/Users/someone/code/elsewhere" }]) {
      const result = await writer.callTool({
        name: "kb.save_session_summary",
        arguments: { sessionId: sessionId(), summaryMd: "Somewhere.", ...extra },
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/^project_unresolved: /);
    }
  });

  it("is not offered to job tokens", async () => {
    const project = await newProject();
    const { client } = await jobClient(project.id);
    const result = await client.callTool({
      name: "kb.save_session_summary",
      arguments: { projectId: project.id, sessionId: sessionId(), summaryMd: "Nope." },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("forbidden: Job tokens cannot call this tool.");
  });
});

describe("projectIdFromCwd", () => {
  it("reads the project id from a Loomcast project folder", () => {
    const id = randomUUID();
    expect(projectIdFromCwd(`/Users/a/Loomcast/projects/${id}`)).toBe(id);
    expect(projectIdFromCwd(`/Users/a/Loomcast/projects/${id}/renders/x`)).toBe(id);
    expect(projectIdFromCwd(`/Users/a/loomcast/projects/${id.toUpperCase()}/`)).toBe(id);
    expect(projectIdFromCwd(`C:\\Users\\a\\Loomcast\\projects\\${id}`)).toBe(id);
    expect(projectIdFromCwd(`/Users/a/Loomcast/projects/${id}x`)).toBeNull();
    expect(projectIdFromCwd(`/Users/a/projects/${id}`)).toBeNull();
    expect(projectIdFromCwd("/Users/a/Loomcast/projects/not-a-uuid")).toBeNull();
  });
});

describe("project binding of job tokens", () => {
  it("refuses another project in every kb tool that names one", async () => {
    const own = await newProject("Own");
    const other = await newProject("Other");
    const foreign = await brainstorm(writer, other.id);
    const { client, row } = await jobClient(own.id);
    const before = await testDb.db
      .select({ id: kbEntries.id })
      .from(kbEntries)
      .where(eq(kbEntries.projectId, other.id));

    const calls: { name: string; arguments: Record<string, unknown> }[] = [
      {
        name: "kb.save_brainstorm",
        arguments: { projectId: other.id, title: "Elsewhere", bodyMd: "Wrong project." },
      },
      {
        name: "kb.add_reference",
        arguments: { projectId: other.id, url: "https://www.youtube.com/shorts/abcdefghijk" },
      },
      {
        name: "kb.add_decision",
        arguments: { projectId: other.id, title: "Elsewhere", decision: "Wrong project." },
      },
      { name: "kb.search", arguments: { query: "hooks", projectId: other.id } },
      { name: "kb.get", arguments: { entryId: foreign.entryId } },
    ];
    for (const call of calls) {
      const result = await client.callTool(call);
      expect(result.isError, call.name).toBe(true);
      expect(textOf(result), call.name).toBe(
        "forbidden: This token can only be used with its own project.",
      );
      expect(result.structuredContent).toBeUndefined();
    }
    const summary = await client.callTool({
      name: "kb.save_session_summary",
      arguments: { projectId: other.id, sessionId: "s", summaryMd: "Wrong project." },
    });
    expect(textOf(summary)).toBe("forbidden: Job tokens cannot call this tool.");

    const after = await testDb.db
      .select({ id: kbEntries.id })
      .from(kbEntries)
      .where(eq(kbEntries.projectId, other.id));
    expect(after).toHaveLength(before.length);

    const denied = await testDb.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, TOOL_CALL_AUDIT_ACTION), eq(auditLog.actorId, row.id)));
    expect(denied).toHaveLength(calls.length + 1);
    expect(denied.every((audit) => audit.data?.outcome === "denied")).toBe(true);
  });

  it("accepts the job's own project, named or left out", async () => {
    const own = await newProject("Own again");
    const { client } = await jobClient(own.id);
    const named = await brainstorm(client, own.id);
    const get = await client.callTool({ name: "kb.get", arguments: { entryId: named.entryId } });
    expectOk(get);
    const search = await client.callTool({
      name: "kb.search",
      arguments: { query: "rewind", projectId: own.id },
    });
    expect(KbSearchOutputSchema.parse(search.structuredContent).hits.map((h) => h.entryId)).toEqual(
      [named.entryId],
    );
  });

  it("stops a job token once it is revoked", async () => {
    const own = await newProject();
    const { secret, job } = await jobClient(own.id);
    const tools = { jsonrpc: "2.0", id: 1, method: "tools/list" };
    expect((await rpc(server.url, tools, bearer(secret))).status).toBe(200);

    const revoked = await createTokensService(server.deps).revokeForJob(job.id);
    expect(revoked).toBe(1);
    const refused = await rpc(server.url, tools, bearer(secret));
    expect(refused.status).toBe(401);
    expect(refused.headers.get("www-authenticate")).toMatch(/^Bearer /);
  });
});
