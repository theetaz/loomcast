import { randomUUID } from "node:crypto";
import {
  type LiveEvent,
  ProjectCreateOutputSchema,
  ProjectGetOutputSchema,
  ProjectListOutputSchema,
  projectTools,
} from "@loomcast/contracts";
import { auditLog, jobs, projects } from "@loomcast/db";
import { createTestDb, type TestDb } from "@loomcast/db/testing";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProjectTools, type McpCaller, TOOL_CALL_AUDIT_ACTION } from "../src/modules/mcp";
import { createProjectsService } from "../src/modules/projects";
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

async function createProject(name: string, extra: Record<string, unknown> = {}) {
  const result = await writer.callTool({
    name: "project.create",
    arguments: { name, ...extra },
  });
  expect(result.isError).toBeFalsy();
  return ProjectCreateOutputSchema.parse(result.structuredContent).project;
}

describe("project tools", () => {
  it("lists the project tools with their contracts", async () => {
    const { tools } = await reader.listTools();
    const names = tools.map((tool) => tool.name).sort();
    expect(names).toEqual(["project.create", "project.get", "project.list"]);
    for (const tool of tools) {
      const contract = projectTools[tool.name as keyof typeof projectTools];
      expect(tool.description).toBe(contract.description);
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.outputSchema?.type).toBe("object");
      expect(tool.annotations?.readOnlyHint).toBe(contract.scope === "mcp:read");
    }
    const create = tools.find((tool) => tool.name === "project.create");
    expect(create?.inputSchema.required).toEqual(["name"]);
  });

  it("creates a project that is stored, audited and published live", async () => {
    const name = uniqueName("Rust in 60 seconds");
    const result = await writer.callTool({
      name: "project.create",
      arguments: { name, description: "Short explainers." },
    });
    expect(result.isError).toBeFalsy();
    const { project } = ProjectCreateOutputSchema.parse(result.structuredContent);
    expect(project).toMatchObject({ name, description: "Short explainers." });
    expect(project.url).toBe(`${APP_ORIGIN}/projects/${project.slug}`);
    expect(textOf(result)).toContain(project.id);
    expect(textOf(result)).toContain(project.url);

    const [row] = await testDb.db.select().from(projects).where(eq(projects.id, project.id));
    expect(row).toMatchObject({ name, slug: project.slug, createdBy: userId });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "project.created",
        payload: { project: expect.objectContaining({ id: project.id, name }) },
      }),
    );

    const audits = await testDb.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.actorKind, "token"), eq(auditLog.actorId, writerTokenId)));
    expect(audits).toContainEqual(
      expect.objectContaining({ action: "project.created", targetId: project.id }),
    );
    expect(audits).toContainEqual(
      expect.objectContaining({
        action: TOOL_CALL_AUDIT_ACTION,
        targetId: "project.create",
        data: { outcome: "ok" },
      }),
    );
  });

  it("refuses to create with a read-only token", async () => {
    const name = uniqueName("Read only");
    const result = await reader.callTool({ name: "project.create", arguments: { name } });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(textOf(result)).toMatch(/^forbidden: .*mcp:write/);
    const rows = await testDb.db.select().from(projects).where(eq(projects.name, name));
    expect(rows).toHaveLength(0);
  });

  it("reports a taken slug as a conflict", async () => {
    const first = await createProject(uniqueName("Taken"));
    const result = await writer.callTool({
      name: "project.create",
      arguments: { name: uniqueName("Again"), slug: first.slug },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("conflict: A project already uses that slug.");
  });

  it("rejects invalid input", async () => {
    const result = await writer.callTool({ name: "project.create", arguments: { name: "" } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/Input validation error/);
  });

  it("gets a project by id or slug with its stats", async () => {
    const created = await createProject(uniqueName("Lookup"));
    for (const idOrSlug of [created.id, created.slug]) {
      const result = await reader.callTool({ name: "project.get", arguments: { idOrSlug } });
      expect(result.isError).toBeFalsy();
      const output = ProjectGetOutputSchema.parse(result.structuredContent);
      expect(output.project).toMatchObject({ id: created.id, status: "active" });
      expect(output.stats).toEqual({ conversations: 0, kbEntries: 0, items: 0 });
      expect(textOf(result)).toContain(created.slug);
    }

    const missing = await reader.callTool({
      name: "project.get",
      arguments: { idOrSlug: randomUUID() },
    });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toBe("not_found: No project has that id or slug.");
  });

  it("lists projects, optionally by status", async () => {
    const created = await createProject(uniqueName("Listed"));
    const all = await reader.callTool({ name: "project.list", arguments: {} });
    const listed = ProjectListOutputSchema.parse(all.structuredContent).projects;
    expect(listed.map((project) => project.id)).toContain(created.id);
    expect(textOf(all)).toContain(`${listed.length} project`);

    const archived = await reader.callTool({
      name: "project.list",
      arguments: { status: "archived" },
    });
    expect(ProjectListOutputSchema.parse(archived.structuredContent).projects).toEqual([]);
    expect(textOf(archived)).toBe("No projects found.");
  });
});

describe("project tools for a bound caller", () => {
  function jobCaller(boundProjectId: string): McpCaller {
    return {
      token: {
        id: randomUUID(),
        kind: "job",
        name: "job token",
        scopes: ["mcp:read", "mcp:write"],
        user: { id: userId, email: "owner@example.test", name: "Owner", role: "owner" },
      },
      boundProjectId,
      jobId: randomUUID(),
      ip: testIp(9),
    };
  }

  function tool(name: string) {
    const tools = createProjectTools({
      projects: createProjectsService(server.deps),
      appOrigin: APP_ORIGIN,
    });
    const found = tools.find((candidate) => candidate.contract.name === name);
    if (found === undefined) {
      throw new Error(`no tool ${name}`);
    }
    return found;
  }

  it("only sees and reads its own project, and cannot create one", async () => {
    const own = await createProject(uniqueName("Own"));
    const other = await createProject(uniqueName("Other"));
    const ctx = { caller: jobCaller(own.id), logger: server.deps.logger, db: testDb.db };

    const list = await tool("project.list").run({}, ctx);
    const listed = ProjectListOutputSchema.parse(list.structuredContent).projects;
    expect(listed.map((project) => project.id)).toEqual([own.id]);

    const get = await tool("project.get").run({ idOrSlug: own.slug }, ctx);
    expect(get.isError).toBeFalsy();
    const denied = await tool("project.get").run({ idOrSlug: other.slug }, ctx);
    expect(denied.isError).toBe(true);
    expect(textOf(denied)).toMatch(/^forbidden: /);

    const create = await tool("project.create").run({ name: uniqueName("Nope") }, ctx);
    expect(create.isError).toBe(true);
    expect(textOf(create)).toBe("forbidden: Job tokens cannot call this tool.");
  });
});

describe("project tools with a job token", () => {
  it("binds the token to its job's project", async () => {
    const own = await createProject(uniqueName("Job own"));
    const other = await createProject(uniqueName("Job other"));
    const { secret, job, row } = await issueJobToken(testDb.db, {
      userId,
      projectId: own.id,
      scopes: ["mcp:read", "mcp:write"],
    });
    const client = await connectClient(server.url, secret);

    const list = await client.callTool({ name: "project.list", arguments: {} });
    const listed = ProjectListOutputSchema.parse(list.structuredContent).projects;
    expect(listed.map((project) => project.id)).toEqual([own.id]);

    const get = await client.callTool({ name: "project.get", arguments: { idOrSlug: own.slug } });
    expect(get.isError).toBeFalsy();
    const denied = await client.callTool({
      name: "project.get",
      arguments: { idOrSlug: other.id },
    });
    expect(denied.isError).toBe(true);
    expect(textOf(denied)).toMatch(/^forbidden: /);

    const create = await client.callTool({
      name: "project.create",
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
