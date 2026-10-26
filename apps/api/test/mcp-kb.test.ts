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
import { auditLog, conversations, jobs, kbEntries, kbReferences, workspaces } from "@loomcast/db";
import { createTestDb, type TestDb } from "@loomcast/db/testing";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { kbEntryUrl, TOOL_CALL_AUDIT_ACTION, workspaceIdFromCwd } from "../src/modules/mcp";
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

async function newWorkspace(label = "Knowledge") {
  const [workspace] = await testDb.db
    .insert(workspaces)
    .values({ slug: `mcp-kb-${randomUUID().slice(0, 8)}`, name: label, createdBy: userId })
    .returning();
  if (workspace === undefined) {
    throw new Error("workspace was not inserted");
  }
  return workspace;
}

async function newConversation(workspaceId: string): Promise<string> {
  const [conversation] = await testDb.db
    .insert(conversations)
    .values({ workspaceId, title: "Planning", createdBy: userId })
    .returning({ id: conversations.id });
  if (conversation === undefined) {
    throw new Error("conversation was not inserted");
  }
  return conversation.id;
}

/** A client with a job token of a running job in `workspaceId`, as a producer session gets one. */
async function jobClient(workspaceId: string, options: { conversationId?: string } = {}) {
  const issued = await issueJobToken(testDb.db, {
    userId,
    workspaceId,
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

async function brainstorm(
  client: Client,
  workspaceId: string,
  extra: Record<string, unknown> = {},
) {
  const result = await client.callTool({
    name: "kb.save_brainstorm",
    arguments: {
      workspaceId,
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
    const workspace = await newWorkspace();
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

    const output = await brainstorm(writer, workspace.id, {
      tags: ["Hooks", "diagrams"],
      sessionRef: "chat-42",
    });
    expect(output.url).toBe(kbEntryUrl(APP_ORIGIN, workspace.id, output.entryId));
    expect(output.url).toBe(`${APP_ORIGIN}/w/${workspace.id}/kb/${output.entryId}`);

    await readUntil(output.entryId);
    await body.cancel();
    expect(received).toContain('"type":"kb.entry.created"');

    expect(await entryRow(output.entryId)).toMatchObject({
      workspaceId: workspace.id,
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
        data: { outcome: "ok", workspaceId: workspace.id },
      }),
    );
  });

  it("marks a producer session's brainstorm and links its conversation", async () => {
    const workspace = await newWorkspace();
    const conversationId = await newConversation(workspace.id);
    const { client, row, job } = await jobClient(workspace.id, { conversationId });
    const output = await brainstorm(client, workspace.id);
    expect(await entryRow(output.entryId)).toMatchObject({
      createdVia: "producer",
      createdByTokenId: row.id,
      conversationId,
    });

    // A job without a conversation writes an unlinked entry, into its workspace by default.
    const plain = await jobClient(workspace.id);
    const result = await plain.client.callTool({
      name: "kb.add_decision",
      arguments: { workspaceId: workspace.id, title: "Voice", decision: "Use one narrator." },
    });
    expectOk(result);
    const { entryId } = KbAddDecisionOutputSchema.parse(result.structuredContent);
    expect(await entryRow(entryId)).toMatchObject({ createdVia: "producer", conversationId: null });

    const [audit] = await testDb.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, TOOL_CALL_AUDIT_ACTION), eq(auditLog.actorId, row.id)));
    expect(audit?.data).toEqual({ outcome: "ok", workspaceId: workspace.id, jobId: job.id });
  });

  it("adds a reference without analysing it or fetching it", async () => {
    const workspace = await newWorkspace();
    const url = `https://www.youtube.com/shorts/${randomUUID().slice(0, 11)}`;
    const result = await writer.callTool({
      name: "kb.add_reference",
      arguments: {
        workspaceId: workspace.id,
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
      .where(and(eq(jobs.workspaceId, workspace.id), eq(jobs.type, "kb.analyze_reference")));
    expect(analyses).toEqual([]);

    // An analysis made by the caller is stored as done.
    const analysed = await writer.callTool({
      name: "kb.add_reference",
      arguments: {
        workspaceId: workspace.id,
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
      arguments: { workspaceId: workspace.id, url },
    });
    expect(duplicate.isError).toBe(true);
    expect(textOf(duplicate)).toBe(
      `conflict: This reference is already saved in the workspace as entry ${entryId}.`,
    );
  });

  it("records decisions and supersedes earlier ones", async () => {
    const workspace = await newWorkspace();
    const first = KbAddDecisionOutputSchema.parse(
      (
        await writer.callTool({
          name: "kb.add_decision",
          arguments: {
            workspaceId: workspace.id,
            title: "Length",
            decision: "Keep shorts at 45 s.",
          },
        })
      ).structuredContent,
    );
    const result = await writer.callTool({
      name: "kb.add_decision",
      arguments: {
        workspaceId: workspace.id,
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
        workspaceId: workspace.id,
        title: "Nope",
        decision: "Nothing to replace.",
        supersedes: randomUUID(),
      },
    });
    expect(unknown.isError).toBe(true);
    expect(textOf(unknown)).toBe(
      "validation_failed: The request is not valid. (supersedes: No decision with that id in this workspace)",
    );
  });

  it("searches one workspace or all of them", async () => {
    const word = `zebrafish${randomUUID().slice(0, 6)}`;
    const one = await newWorkspace("One");
    const two = await newWorkspace("Two");
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
      arguments: { query: word, workspaceId: one.id, kinds: ["brainstorm"], limit: 5 },
    });
    expect(KbSearchOutputSchema.parse(scoped.structuredContent).hits).toEqual([
      expect.objectContaining({ entryId: a.entryId, workspaceId: one.id, kind: "brainstorm" }),
    ]);

    const decisions = await reader.callTool({
      name: "kb.search",
      arguments: { query: word, kinds: ["decision"] },
    });
    expect(KbSearchOutputSchema.parse(decisions.structuredContent).hits).toEqual([]);
    expect(textOf(decisions)).toBe("No knowledge-base entries match.");

    // A job token without a workspace searches its own workspace only.
    const { client } = await jobClient(two.id);
    const bound = await client.callTool({ name: "kb.search", arguments: { query: word } });
    expect(KbSearchOutputSchema.parse(bound.structuredContent).hits.map((h) => h.entryId)).toEqual([
      b.entryId,
    ]);
  });

  it("gets an entry with its details", async () => {
    const workspace = await newWorkspace();
    const { entryId } = await brainstorm(writer, workspace.id);
    const result = await reader.callTool({ name: "kb.get", arguments: { entryId } });
    expectOk(result);
    const { entry } = KbGetOutputSchema.parse(result.structuredContent);
    expect(entry).toMatchObject({
      id: entryId,
      workspaceId: workspace.id,
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
    const workspace = await newWorkspace();
    const result = await reader.callTool({
      name: "kb.save_brainstorm",
      arguments: { workspaceId: workspace.id, title: "Nope", bodyMd: "Read only." },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/^forbidden: .*mcp:write/);
  });

  it("reports unknown and archived workspaces", async () => {
    const missing = await writer.callTool({
      name: "kb.save_brainstorm",
      arguments: { workspaceId: randomUUID(), title: "Lost", bodyMd: "Nowhere." },
    });
    expect(textOf(missing)).toBe("not_found: Workspace not found.");

    const workspace = await newWorkspace();
    await testDb.db
      .update(workspaces)
      .set({ status: "archived", archivedAt: new Date() })
      .where(eq(workspaces.id, workspace.id));
    const archived = await writer.callTool({
      name: "kb.save_brainstorm",
      arguments: { workspaceId: workspace.id, title: "Late", bodyMd: "Too late." },
    });
    expect(textOf(archived)).toMatch(/^conflict: The workspace is archived/);
  });
});

describe("kb.save_session_summary", () => {
  const sessionId = () => `session-${randomUUID()}`;

  it("saves a summary for a named workspace and replaces it on a second call", async () => {
    const workspace = await newWorkspace();
    const id = sessionId();
    const first = await writer.callTool({
      name: "kb.save_session_summary",
      arguments: {
        workspaceId: workspace.id,
        sessionId: id,
        summaryMd: "# Picked a hook\nDetails.",
      },
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
      arguments: { workspaceId: workspace.id, sessionId: id, summaryMd: "Changed the hook." },
    });
    expect(KbSaveSessionSummaryOutputSchema.parse(again.structuredContent).entryId).toBe(entryId);
    expect((await entryRow(entryId))?.bodyMd).toBe("Changed the hook.");
  });

  it("finds the workspace from the working directory", async () => {
    const workspace = await newWorkspace();
    const cwd = `/Users/someone/Loomcast/projects/${workspace.id}/scripts`;
    const result = await writer.callTool({
      name: "kb.save_session_summary",
      arguments: { sessionId: sessionId(), summaryMd: "Wrote the script.", cwd },
    });
    expectOk(result);
    const { entryId } = KbSaveSessionSummaryOutputSchema.parse(result.structuredContent);
    expect(await entryRow(entryId)).toMatchObject({ workspaceId: workspace.id, data: { cwd } });
  });

  it("fails with workspace_unresolved without a workspace or a workspace folder", async () => {
    for (const extra of [{}, { cwd: "/Users/someone/code/elsewhere" }]) {
      const result = await writer.callTool({
        name: "kb.save_session_summary",
        arguments: { sessionId: sessionId(), summaryMd: "Somewhere.", ...extra },
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/^workspace_unresolved: /);
    }
  });

  it("is not offered to job tokens", async () => {
    const workspace = await newWorkspace();
    const { client } = await jobClient(workspace.id);
    const result = await client.callTool({
      name: "kb.save_session_summary",
      arguments: { workspaceId: workspace.id, sessionId: sessionId(), summaryMd: "Nope." },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("forbidden: Job tokens cannot call this tool.");
  });
});

describe("workspaceIdFromCwd", () => {
  it("reads the workspace id from a Loomcast projects folder", () => {
    const id = randomUUID();
    expect(workspaceIdFromCwd(`/Users/a/Loomcast/projects/${id}`)).toBe(id);
    expect(workspaceIdFromCwd(`/Users/a/Loomcast/projects/${id}/renders/x`)).toBe(id);
    expect(workspaceIdFromCwd(`/Users/a/loomcast/projects/${id.toUpperCase()}/`)).toBe(id);
    expect(workspaceIdFromCwd(`C:\\Users\\a\\Loomcast\\projects\\${id}`)).toBe(id);
    expect(workspaceIdFromCwd(`/Users/a/Loomcast/projects/${id}x`)).toBeNull();
    expect(workspaceIdFromCwd(`/Users/a/projects/${id}`)).toBeNull();
    expect(workspaceIdFromCwd("/Users/a/Loomcast/projects/not-a-uuid")).toBeNull();
  });
});

describe("workspace binding of job tokens", () => {
  it("refuses another workspace in every kb tool that names one", async () => {
    const own = await newWorkspace("Own");
    const other = await newWorkspace("Other");
    const foreign = await brainstorm(writer, other.id);
    const { client, row } = await jobClient(own.id);
    const before = await testDb.db
      .select({ id: kbEntries.id })
      .from(kbEntries)
      .where(eq(kbEntries.workspaceId, other.id));

    const calls: { name: string; arguments: Record<string, unknown> }[] = [
      {
        name: "kb.save_brainstorm",
        arguments: { workspaceId: other.id, title: "Elsewhere", bodyMd: "Wrong workspace." },
      },
      {
        name: "kb.add_reference",
        arguments: { workspaceId: other.id, url: "https://www.youtube.com/shorts/abcdefghijk" },
      },
      {
        name: "kb.add_decision",
        arguments: { workspaceId: other.id, title: "Elsewhere", decision: "Wrong workspace." },
      },
      { name: "kb.search", arguments: { query: "hooks", workspaceId: other.id } },
      { name: "kb.get", arguments: { entryId: foreign.entryId } },
    ];
    for (const call of calls) {
      const result = await client.callTool(call);
      expect(result.isError, call.name).toBe(true);
      expect(textOf(result), call.name).toBe(
        "forbidden: This token can only be used with its own workspace.",
      );
      expect(result.structuredContent).toBeUndefined();
    }
    const summary = await client.callTool({
      name: "kb.save_session_summary",
      arguments: { workspaceId: other.id, sessionId: "s", summaryMd: "Wrong workspace." },
    });
    expect(textOf(summary)).toBe("forbidden: Job tokens cannot call this tool.");

    const after = await testDb.db
      .select({ id: kbEntries.id })
      .from(kbEntries)
      .where(eq(kbEntries.workspaceId, other.id));
    expect(after).toHaveLength(before.length);

    const denied = await testDb.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, TOOL_CALL_AUDIT_ACTION), eq(auditLog.actorId, row.id)));
    expect(denied).toHaveLength(calls.length + 1);
    expect(denied.every((audit) => audit.data?.outcome === "denied")).toBe(true);
  });

  it("accepts the job's own workspace, named or left out", async () => {
    const own = await newWorkspace("Own again");
    const { client } = await jobClient(own.id);
    const named = await brainstorm(client, own.id);
    const get = await client.callTool({ name: "kb.get", arguments: { entryId: named.entryId } });
    expectOk(get);
    const search = await client.callTool({
      name: "kb.search",
      arguments: { query: "rewind", workspaceId: own.id },
    });
    expect(KbSearchOutputSchema.parse(search.structuredContent).hits.map((h) => h.entryId)).toEqual(
      [named.entryId],
    );
  });

  it("stops a job token once it is revoked", async () => {
    const own = await newWorkspace();
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
