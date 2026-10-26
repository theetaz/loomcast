import { randomUUID } from "node:crypto";
import {
  type LiveEvent,
  WorkspaceCreateOutputSchema,
  WorkspaceGetOutputSchema,
  WorkspaceListOutputSchema,
  workspaceTools,
} from "@loomcast/contracts";
import { auditLog, jobs, workspaces } from "@loomcast/db";
import { createTestDb, type TestDb } from "@loomcast/db/testing";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWorkspaceTools, type McpCaller, TOOL_CALL_AUDIT_ACTION } from "../src/modules/mcp";
import { createWorkspacesService } from "../src/modules/workspaces";
import {
  connectClient,
  issueJobToken,
  issueToken,
  type McpTestServer,
  rpc,
  startMcpTestServer,
} from "./mcp-support";
import { APP_ORIGIN, insertUser, testIp } from "./support";

let testDb: TestDb;
let server: McpTestServer;
let userId: string;
let writer: Client;
let writerTokenId: string;
let reader: Client;
const events: LiveEvent[] = [];

beforeAll(async () => {
  testDb = await createTestDb();
  server = await startMcpTestServer(testDb.db);
  server.deps.bus.subscribeLive((event) => {
    events.push(event);
  });
  userId = (await insertUser(testDb.db)).id;
  const write = await issueToken(server.deps, userId, ["mcp:read", "mcp:write"]);
  writerTokenId = write.row.id;
  writer = await connectClient(server.url, write.secret);
  reader = await connectClient(
    server.url,
    (await issueToken(server.deps, userId, ["mcp:read"])).secret,
  );
});

afterAll(async () => {
  await writer?.close();
  await reader?.close();
  await server?.close();
  await testDb?.drop();
});

function uniqueName(label: string): string {
  return `${label} ${randomUUID().slice(0, 8)}`;
}

function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const [first] = result.content as { type: string; text: string }[];
  return first?.text ?? "";
}

async function createWorkspace(name: string, extra: Record<string, unknown> = {}) {
  const result = await writer.callTool({
    name: "workspace.create",
    arguments: { name, ...extra },
  });
  expect(result.isError).toBeFalsy();
  return WorkspaceCreateOutputSchema.parse(result.structuredContent).workspace;
}

describe("workspace tools", () => {
  it("lists the workspace tools with their contracts", async () => {
    const { tools: all } = await reader.listTools();
    const tools = all.filter((tool) => tool.name.startsWith("workspace."));
    const names = tools.map((tool) => tool.name).sort();
    expect(names).toEqual(["workspace.create", "workspace.get", "workspace.list"]);
    for (const tool of tools) {
      const contract = workspaceTools[tool.name as keyof typeof workspaceTools];
      expect(tool.description).toBe(contract.description);
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.outputSchema?.type).toBe("object");
      expect(tool.annotations?.readOnlyHint).toBe(contract.scope === "mcp:read");
    }
    const create = tools.find((tool) => tool.name === "workspace.create");
    expect(create?.inputSchema.required).toEqual(["name"]);
  });

  it("creates a workspace that is stored, audited and published live", async () => {
    const name = uniqueName("Rust in 60 seconds");
    const result = await writer.callTool({
      name: "workspace.create",
      arguments: { name, description: "Short explainers." },
    });
    expect(result.isError).toBeFalsy();
    const { workspace } = WorkspaceCreateOutputSchema.parse(result.structuredContent);
    expect(workspace).toMatchObject({ name, description: "Short explainers." });
    expect(workspace.url).toBe(`${APP_ORIGIN}/w/${workspace.slug}`);
    expect(textOf(result)).toContain(workspace.id);
    expect(textOf(result)).toContain(workspace.url);

    const [row] = await testDb.db.select().from(workspaces).where(eq(workspaces.id, workspace.id));
    expect(row).toMatchObject({ name, slug: workspace.slug, createdBy: userId });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "workspace.created",
        payload: { workspace: expect.objectContaining({ id: workspace.id, name }) },
      }),
    );

    const audits = await testDb.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.actorKind, "token"), eq(auditLog.actorId, writerTokenId)));
    expect(audits).toContainEqual(
      expect.objectContaining({ action: "workspace.created", targetId: workspace.id }),
    );
    expect(audits).toContainEqual(
      expect.objectContaining({
        action: TOOL_CALL_AUDIT_ACTION,
        targetId: "workspace.create",
        data: { outcome: "ok" },
      }),
    );
  });

  it("refuses to create with a read-only token", async () => {
    const name = uniqueName("Read only");
    const result = await reader.callTool({ name: "workspace.create", arguments: { name } });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(textOf(result)).toMatch(/^forbidden: .*mcp:write/);
    const rows = await testDb.db.select().from(workspaces).where(eq(workspaces.name, name));
    expect(rows).toHaveLength(0);
  });

  it("reports a taken slug as a conflict", async () => {
    const first = await createWorkspace(uniqueName("Taken"));
    const result = await writer.callTool({
      name: "workspace.create",
      arguments: { name: uniqueName("Again"), slug: first.slug },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("conflict: A workspace already uses that slug.");
  });

  it("rejects invalid input", async () => {
    const result = await writer.callTool({ name: "workspace.create", arguments: { name: "" } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/Input validation error/);
  });

  it("gets a workspace by id or slug with its stats", async () => {
    const created = await createWorkspace(uniqueName("Lookup"));
    for (const idOrSlug of [created.id, created.slug]) {
      const result = await reader.callTool({ name: "workspace.get", arguments: { idOrSlug } });
      expect(result.isError).toBeFalsy();
      const output = WorkspaceGetOutputSchema.parse(result.structuredContent);
      expect(output.workspace).toMatchObject({ id: created.id, status: "active" });
      expect(output.stats).toEqual({ conversations: 0, kbEntries: 0, items: 0 });
      expect(textOf(result)).toContain(created.slug);
    }

    const missing = await reader.callTool({
      name: "workspace.get",
      arguments: { idOrSlug: randomUUID() },
    });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toBe("not_found: No workspace has that id or slug.");
  });

  it("lists workspaces, optionally by status", async () => {
    const created = await createWorkspace(uniqueName("Listed"));
    const all = await reader.callTool({ name: "workspace.list", arguments: {} });
    const listed = WorkspaceListOutputSchema.parse(all.structuredContent).workspaces;
    expect(listed.map((workspace) => workspace.id)).toContain(created.id);
    expect(textOf(all)).toContain(`${listed.length} workspace`);

    const archived = await reader.callTool({
      name: "workspace.list",
      arguments: { status: "archived" },
    });
    expect(WorkspaceListOutputSchema.parse(archived.structuredContent).workspaces).toEqual([]);
    expect(textOf(archived)).toBe("No workspaces found.");
  });
});

describe("deprecated project tools", () => {
  it("lists project.create, project.get and project.list as deprecated aliases", async () => {
    const { tools } = await writer.listTools();
    for (const name of ["create", "get", "list"] as const) {
      const alias = tools.find((tool) => tool.name === `project.${name}`);
      const current = tools.find((tool) => tool.name === `workspace.${name}`);
      expect(alias, `project.${name}`).toBeDefined();
      expect(alias?.description).toBe(`Deprecated: use workspace.${name}. ${current?.description}`);
      expect(alias?.inputSchema).toEqual(current?.inputSchema);
      expect(alias?.outputSchema).toEqual(current?.outputSchema);
      expect(alias?.annotations?.readOnlyHint).toBe(current?.annotations?.readOnlyHint);
    }
  });

  it("answers project.get and project.list as workspace.get and workspace.list do", async () => {
    const created = await createWorkspace(uniqueName("Alias"));
    for (const idOrSlug of [created.id, created.slug]) {
      const legacy = await reader.callTool({ name: "project.get", arguments: { idOrSlug } });
      const current = await reader.callTool({ name: "workspace.get", arguments: { idOrSlug } });
      expect(legacy.isError).toBeFalsy();
      expect(WorkspaceGetOutputSchema.parse(legacy.structuredContent).workspace.id).toBe(
        created.id,
      );
      expect(legacy.structuredContent).toEqual(current.structuredContent);
      expect(legacy.content).toEqual(current.content);
    }

    const legacyList = await reader.callTool({ name: "project.list", arguments: {} });
    const currentList = await reader.callTool({ name: "workspace.list", arguments: {} });
    expect(legacyList.isError).toBeFalsy();
    expect(legacyList.structuredContent).toEqual(currentList.structuredContent);
    expect(
      WorkspaceListOutputSchema.parse(legacyList.structuredContent).workspaces.map(
        (workspace) => workspace.id,
      ),
    ).toContain(created.id);

    const missing = await reader.callTool({
      name: "project.get",
      arguments: { idOrSlug: randomUUID() },
    });
    expect(textOf(missing)).toBe("not_found: No workspace has that id or slug.");
  });

  it("creates a workspace through project.create", async () => {
    const name = uniqueName("Legacy create");
    const result = await writer.callTool({ name: "project.create", arguments: { name } });
    expect(result.isError).toBeFalsy();
    const { workspace } = WorkspaceCreateOutputSchema.parse(result.structuredContent);
    expect(workspace).toMatchObject({ name, url: `${APP_ORIGIN}/w/${workspace.slug}` });
    const [row] = await testDb.db.select().from(workspaces).where(eq(workspaces.id, workspace.id));
    expect(row?.name).toBe(name);
    const readOnly = await reader.callTool({ name: "project.create", arguments: { name } });
    expect(readOnly.isError).toBe(true);
  });
});

describe("workspace tools for a bound caller", () => {
  function jobCaller(boundWorkspaceId: string): McpCaller {
    return {
      token: {
        id: randomUUID(),
        kind: "job",
        name: "job token",
        scopes: ["mcp:read", "mcp:write"],
        user: { id: userId, email: "owner@example.test", name: "Owner", role: "owner" },
      },
      boundWorkspaceId,
      jobId: randomUUID(),
      ip: testIp(9),
    };
  }

  function tool(name: string) {
    const tools = createWorkspaceTools({
      workspaces: createWorkspacesService(server.deps),
      appOrigin: APP_ORIGIN,
    });
    const found = tools.find((candidate) => candidate.contract.name === name);
    if (found === undefined) {
      throw new Error(`no tool ${name}`);
    }
    return found;
  }

  it("only sees and reads its own workspace, and cannot create one", async () => {
    const own = await createWorkspace(uniqueName("Own"));
    const other = await createWorkspace(uniqueName("Other"));
    const ctx = { caller: jobCaller(own.id), logger: server.deps.logger, db: testDb.db };

    const list = await tool("workspace.list").run({}, ctx);
    const listed = WorkspaceListOutputSchema.parse(list.structuredContent).workspaces;
    expect(listed.map((workspace) => workspace.id)).toEqual([own.id]);

    const get = await tool("workspace.get").run({ idOrSlug: own.slug }, ctx);
    expect(get.isError).toBeFalsy();
    const denied = await tool("workspace.get").run({ idOrSlug: other.slug }, ctx);
    expect(denied.isError).toBe(true);
    expect(textOf(denied)).toMatch(/^forbidden: /);

    const create = await tool("workspace.create").run({ name: uniqueName("Nope") }, ctx);
    expect(create.isError).toBe(true);
    expect(textOf(create)).toBe("forbidden: Job tokens cannot call this tool.");
  });
});

describe("workspace tools with a job token", () => {
  it("binds the token to its job's workspace", async () => {
    const own = await createWorkspace(uniqueName("Job own"));
    const other = await createWorkspace(uniqueName("Job other"));
    const { secret, job, row } = await issueJobToken(testDb.db, {
      userId,
      workspaceId: own.id,
      scopes: ["mcp:read", "mcp:write"],
    });
    const client = await connectClient(server.url, secret);

    const list = await client.callTool({ name: "workspace.list", arguments: {} });
    const listed = WorkspaceListOutputSchema.parse(list.structuredContent).workspaces;
    expect(listed.map((workspace) => workspace.id)).toEqual([own.id]);

    const get = await client.callTool({ name: "workspace.get", arguments: { idOrSlug: own.slug } });
    expect(get.isError).toBeFalsy();
    const denied = await client.callTool({
      name: "workspace.get",
      arguments: { idOrSlug: other.id },
    });
    expect(denied.isError).toBe(true);
    expect(textOf(denied)).toMatch(/^forbidden: /);

    const create = await client.callTool({
      name: "workspace.create",
      arguments: { name: uniqueName("From a job") },
    });
    expect(create.isError).toBe(true);
    expect(textOf(create)).toBe("forbidden: Job tokens cannot call this tool.");

    const audits = await testDb.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, TOOL_CALL_AUDIT_ACTION), eq(auditLog.actorId, row.id)));
    expect(audits).toHaveLength(4);
    expect(audits.every((audit) => audit.data?.jobId === job.id)).toBe(true);
    await client.close();

    // The token stops working once its job has finished.
    await testDb.db.update(jobs).set({ status: "succeeded" }).where(eq(jobs.id, job.id));
    const response = await rpc(
      server.url,
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { Authorization: `Bearer ${secret}` },
    );
    expect(response.status).toBe(401);
  });
});
