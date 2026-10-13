import { createHash, randomUUID } from "node:crypto";
import {
  type SkillFile,
  SkillPublishOutputSchema,
  SkillPullOutputSchema,
  skillChecksumInput,
} from "@loomcast/contracts";
import { jobs, projects, skills } from "@loomcast/db";
import { createTestDb, type TestDb } from "@loomcast/db/testing";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  connectClient,
  issueJobToken,
  issueToken,
  type McpTestServer,
  startMcpTestServer,
} from "./mcp-support";
import { insertUser } from "./support";

type CallResult = Awaited<ReturnType<Client["callTool"]>>;

let testDb: TestDb;
let server: McpTestServer;
let userId: string;
let projectId: string;
let writer: Client;
let reader: Client;
let job: Client;

beforeAll(async () => {
  testDb = await createTestDb();
  server = await startMcpTestServer(testDb.db);
  const user = await insertUser(testDb.db);
  userId = user.id;
  const [project] = await testDb.db
    .insert(projects)
    .values({ slug: `mcp-skills-${randomUUID().slice(0, 8)}`, name: "Skills", createdBy: userId })
    .returning();
  if (project === undefined) {
    throw new Error("project was not inserted");
  }
  projectId = project.id;
  writer = await connectClient(
    server.url,
    (await issueToken(server.deps, userId, ["mcp:read", "mcp:write"])).secret,
  );
  reader = await connectClient(
    server.url,
    (await issueToken(server.deps, userId, ["mcp:read"])).secret,
  );
  const issued = await issueJobToken(testDb.db, {
    userId,
    projectId,
    scopes: ["mcp:read", "mcp:write"],
  });
  job = await connectClient(server.url, issued.secret);
});

afterAll(async () => {
  for (const client of [writer, reader, job]) {
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

function expectError(result: CallResult, code: string): void {
  expect(result.isError).toBe(true);
  expect(textOf(result).startsWith(`${code}: `), textOf(result)).toBe(true);
}

/** What the studio agent computes after a pull. */
function localChecksum(files: readonly SkillFile[]): string {
  return createHash("sha256").update(skillChecksumInput(files), "utf8").digest("hex");
}

function skillFiles(name: string, body: string): SkillFile[] {
  return [
    { path: "skill.json", content: JSON.stringify({ name, kind: "skill", description: "Hooks." }) },
    { path: "SKILL.md", content: body },
    { path: "examples/one.md", content: "Ünïcödé text — counted as UTF-8." },
  ];
}

describe("skill tools", () => {
  it("publishes a skill and pulls it back with an identical checksum", async () => {
    const files = skillFiles("hooks", "Open on the payoff.");
    const published = await writer.callTool({
      name: "skill.publish",
      arguments: { name: "hooks", kind: "skill", files, changelog: "First cut" },
    });
    expectOk(published);
    const output = SkillPublishOutputSchema.parse(published.structuredContent);
    expect(output).toMatchObject({ name: "hooks", version: 1, created: true });
    expect(output.checksum).toBe(localChecksum(files));
    expect(textOf(published)).toContain("Published hooks version 1");

    // The new version queues a sync for studio agents.
    const [sync] = await testDb.db.select().from(jobs).where(eq(jobs.type, "skills.sync"));
    expect(sync).toMatchObject({ idempotencyKey: `skills:${output.checksum}`, projectId });

    const pulled = await job.callTool({ name: "skill.pull", arguments: { name: "hooks" } });
    expectOk(pulled);
    const [skill] = SkillPullOutputSchema.parse(pulled.structuredContent).skills;
    expect(skill).toMatchObject({ name: "hooks", kind: "skill", version: 1 });
    expect(skill?.checksum).toBe(output.checksum);
    expect(localChecksum(skill?.files ?? [])).toBe(output.checksum);

    // Identical files publish nothing new.
    const again = await writer.callTool({
      name: "skill.publish",
      arguments: { name: "hooks", kind: "skill", files: [...files].reverse() },
    });
    expectOk(again);
    expect(SkillPublishOutputSchema.parse(again.structuredContent)).toEqual({
      ...output,
      created: false,
    });
  });

  it("pulls every skill at its latest version, or one version", async () => {
    await writer.callTool({
      name: "skill.publish",
      arguments: { name: "pacing", kind: "skill", files: skillFiles("pacing", "v1") },
    });
    const v2 = await writer.callTool({
      name: "skill.publish",
      arguments: { name: "pacing", kind: "skill", files: skillFiles("pacing", "v2") },
    });
    expect(SkillPublishOutputSchema.parse(v2.structuredContent).version).toBe(2);

    const all = await reader.callTool({ name: "skill.pull", arguments: {} });
    expectOk(all);
    const pulled = SkillPullOutputSchema.parse(all.structuredContent).skills;
    expect(pulled.map((skill) => [skill.name, skill.version])).toEqual([
      ["hooks", 1],
      ["pacing", 2],
    ]);
    expect(textOf(all)).toContain("2 skills:");

    const old = await job.callTool({
      name: "skill.pull",
      arguments: { name: "pacing", version: 1 },
    });
    expectOk(old);
    const [first] = SkillPullOutputSchema.parse(old.structuredContent).skills;
    expect(first?.files.find((file) => file.path === "SKILL.md")?.content).toBe("v1");

    expectError(
      await reader.callTool({ name: "skill.pull", arguments: { name: "no-such-skill" } }),
      "not_found",
    );
    expectError(
      await reader.callTool({ name: "skill.pull", arguments: { name: "pacing", version: 7 } }),
      "not_found",
    );
    const versionOnly = await reader.callTool({ name: "skill.pull", arguments: { version: 1 } });
    expect(versionOnly.isError).toBe(true);
  });

  it("refuses publishing to job tokens and read-only tokens", async () => {
    const args = { name: "from-job", kind: "skill", files: skillFiles("from-job", "x") };
    expectError(await job.callTool({ name: "skill.publish", arguments: args }), "forbidden");
    expectError(await reader.callTool({ name: "skill.publish", arguments: args }), "forbidden");
    const rows = await testDb.db.select().from(skills).where(eq(skills.name, "from-job"));
    expect(rows).toEqual([]);
  });

  it("rejects file paths outside the skill before anything is stored", async () => {
    for (const path of ["../outside.md", "nested/../../up.md", "/etc/hosts"]) {
      const result = await writer.callTool({
        name: "skill.publish",
        arguments: { name: "escape", kind: "skill", files: [{ path, content: "nope" }] },
      });
      expect(result.isError, path).toBe(true);
      expect(textOf(result)).toContain("Input validation error");
    }
    const rows = await testDb.db.select().from(skills).where(eq(skills.name, "escape"));
    expect(rows).toEqual([]);
  });

  it("reports a manifest that names another skill", async () => {
    const result = await writer.callTool({
      name: "skill.publish",
      arguments: { name: "mismatch", kind: "skill", files: skillFiles("other-name", "x") },
    });
    expectError(result, "validation_failed");
    expect(textOf(result)).toContain("skill.json");
  });
});
