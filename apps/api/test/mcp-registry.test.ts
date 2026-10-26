import { randomUUID } from "node:crypto";
import type { McpToolContract, TokenScope } from "@loomcast/contracts";
import { auditLog } from "@loomcast/db";
import { createTestDb, type TestDb } from "@loomcast/db/testing";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { conflict } from "../src/lib/errors";
import { createLogger } from "../src/lib/logger";
import {
  defineTool,
  type McpCaller,
  McpToolError,
  registerMcpRoutes,
  TOOL_CALL_AUDIT_ACTION,
  type ToolDefinition,
} from "../src/modules/mcp";
import {
  bearer,
  connectClient,
  issueToken,
  type McpTestServer,
  rpc,
  startMcpTestServer,
} from "./mcp-support";
import { insertUser, testIp } from "./support";

let testDb: TestDb;
const logs: string[] = [];
const logger = createLogger({
  level: "trace",
  destination: { write: (line: string) => void logs.push(line) },
});

beforeAll(async () => {
  testDb = await createTestDb();
});

afterAll(async () => {
  await testDb?.drop();
});

const EchoInput = z.object({ text: z.string().min(1).max(100) });
const EchoOutput = z.object({ text: z.string() });

interface ContractOverrides {
  workspaceBinding: McpToolContract["workspaceBinding"];
  jobTokens?: McpToolContract["jobTokens"];
  scope?: TokenScope;
  input?: z.ZodObject;
}

const CONTRACT_DEFAULTS = {
  scope: "mcp:write",
  jobTokens: "deny",
  description: "A tool used by the tests.",
  input: EchoInput,
  output: EchoOutput,
} as const;

/** A contract for a throwaway tool; `overrides` keep their literal types. */
function contract<const T extends ContractOverrides>(
  overrides: T,
): Omit<typeof CONTRACT_DEFAULTS, keyof T> & T & { name: string } {
  return { ...CONTRACT_DEFAULTS, name: `test.tool_${randomUUID().slice(0, 8)}`, ...overrides };
}

function caller(
  options: { kind?: "mcp" | "job"; scopes?: TokenScope[]; boundWorkspaceId?: string | null } = {},
): McpCaller {
  return {
    token: {
      id: randomUUID(),
      kind: options.kind ?? "mcp",
      name: "test token",
      scopes: options.scopes ?? ["mcp:read", "mcp:write"],
      user: { id: randomUUID(), email: "someone@example.test", name: "Someone", role: "admin" },
    },
    boundWorkspaceId: options.boundWorkspaceId ?? null,
    jobId: options.kind === "job" ? randomUUID() : null,
    ip: testIp(7),
  };
}

function call(tool: ToolDefinition, input: unknown, who: McpCaller) {
  return tool.run(input, { caller: who, logger, db: testDb.db });
}

async function auditFor(who: McpCaller) {
  return testDb.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.action, TOOL_CALL_AUDIT_ACTION), eq(auditLog.actorId, who.token.id)));
}

function text(result: { content: unknown[] }): string {
  const [first] = result.content as { type: string; text: string }[];
  return first?.text ?? "";
}

describe("defineTool", () => {
  it("returns structured content with a summary and audits the call", async () => {
    let runs = 0;
    const tool = defineTool(contract({ workspaceBinding: "none" }), {
      async handler(input) {
        runs += 1;
        return { text: input.text.toUpperCase(), extra: "stripped" } as { text: string };
      },
      summary: (output) => `Echoed ${output.text}`,
    });
    const who = caller();
    const result = await call(tool, { text: "hello" }, who);

    expect(runs).toBe(1);
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({ text: "HELLO" });
    expect(text(result)).toBe("Echoed HELLO");

    const [row] = await auditFor(who);
    expect(row).toMatchObject({
      actorKind: "token",
      targetType: "mcp_tool",
      targetId: tool.contract.name,
      ip: testIp(7),
      data: { outcome: "ok" },
    });
  });

  it("refuses a token without the tool's scope before running it", async () => {
    let runs = 0;
    const tool = defineTool(contract({ workspaceBinding: "none" }), {
      async handler(input) {
        runs += 1;
        return input;
      },
      summary: () => "ran",
    });
    const who = caller({ scopes: ["mcp:read"] });
    const result = await call(tool, { text: "hello" }, who);

    expect(runs).toBe(0);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(text(result)).toMatch(/^forbidden: .*mcp:write/);
    const [row] = await auditFor(who);
    expect(row?.data).toEqual({ outcome: "denied", code: "forbidden" });
  });

  it("applies the job-token policy", async () => {
    const handler = async (input: { text: string }) => input;
    const denied = defineTool(contract({ workspaceBinding: "none", jobTokens: "deny" }), {
      handler,
      summary: () => "ran",
    });
    const allowed = defineTool(contract({ workspaceBinding: "none", jobTokens: "allow" }), {
      handler,
      summary: () => "ran",
    });
    const job = caller({ kind: "job", boundWorkspaceId: randomUUID() });

    const refused = await call(denied, { text: "a" }, job);
    expect(refused.isError).toBe(true);
    expect(text(refused)).toBe("forbidden: Job tokens cannot call this tool.");
    expect((await call(allowed, { text: "a" }, job)).isError).toBeUndefined();
    // A user token is governed by its scopes alone.
    expect((await call(denied, { text: "a" }, caller())).isError).toBeUndefined();

    const rows = await auditFor(job);
    expect(rows.map((row) => row.data?.jobId)).toEqual([job.jobId, job.jobId]);
  });

  describe("workspace binding", () => {
    const WorkspaceInput = z.object({ workspaceId: z.string().optional() });

    function boundTool(seen: (string | null)[]) {
      return defineTool(
        contract({
          workspaceBinding: "input",
          jobTokens: "allow",
          scope: "mcp:read",
          input: WorkspaceInput,
        }),
        {
          async resolveWorkspace(input) {
            if (input.workspaceId === undefined) {
              return undefined;
            }
            return input.workspaceId === "missing" ? null : input.workspaceId;
          },
          async handler(_input, ctx) {
            seen.push(ctx.workspaceId);
            return { text: ctx.workspaceId ?? "none" };
          },
          summary: (output) => output.text,
        },
      );
    }

    it("holds a bound caller to its workspace", async () => {
      const seen: (string | null)[] = [];
      const tool = boundTool(seen);
      const own = randomUUID();
      const job = caller({ kind: "job", scopes: ["mcp:read"], boundWorkspaceId: own });

      expect((await call(tool, { workspaceId: own }, job)).structuredContent).toEqual({
        text: own,
      });
      expect((await call(tool, {}, job)).structuredContent).toEqual({ text: own });

      for (const other of [randomUUID(), "missing"]) {
        const refused = await call(tool, { workspaceId: other }, job);
        expect(refused.isError).toBe(true);
        expect(text(refused)).toMatch(/^forbidden: /);
      }
      expect(seen).toEqual([own, own]);
    });

    it("leaves an unbound caller free to name any workspace", async () => {
      const seen: (string | null)[] = [];
      const tool = boundTool(seen);
      const any = randomUUID();
      await call(tool, { workspaceId: any }, caller());
      await call(tool, { workspaceId: "missing" }, caller());
      await call(tool, {}, caller());
      expect(seen).toEqual([any, null, null]);

      const who = caller();
      await call(tool, { workspaceId: any }, who);
      const [row] = await auditFor(who);
      expect(row?.data).toEqual({ outcome: "ok", workspaceId: any });
    });
  });

  it("maps failures to tool errors without internals", async () => {
    const failing = (error: unknown) =>
      defineTool(contract({ workspaceBinding: "none" }), {
        async handler() {
          throw error;
        },
        summary: () => "ran",
      });
    const badOutput = defineTool(contract({ workspaceBinding: "none" }), {
      async handler() {
        return { text: 42 } as unknown as { text: string };
      },
      summary: () => "ran",
    });
    const cases: [ToolDefinition, string][] = [
      [failing(new McpToolError("not_found", "No such thing.")), "not_found: No such thing."],
      [failing(conflict("Already taken.")), "conflict: Already taken."],
      [
        failing(new Error("database exploded at /srv/private/path")),
        "internal: Something went wrong on our side.",
      ],
      [badOutput, "internal: Something went wrong on our side."],
    ];
    for (const [tool, expected] of cases) {
      const result = await call(tool, { text: "a" }, caller());
      expect(result.isError).toBe(true);
      expect(text(result)).toBe(expected);
      expect(JSON.stringify(result)).not.toMatch(/exploded|\bat .*\.ts:\d+/);
    }
    expect(logs.some((line) => line.includes("database exploded"))).toBe(true);
  });
});

describe("tools over HTTP", () => {
  let server: McpTestServer;
  let userId: string;
  const echo = defineTool(
    {
      name: "test.echo",
      scope: "mcp:write",
      jobTokens: "deny",
      workspaceBinding: "none",
      description: "Echo text back.",
      input: EchoInput,
      output: EchoOutput,
    },
    {
      handler: async (input) => ({ text: input.text }),
      summary: (output) => `Echo: ${output.text}`,
    },
  );

  beforeAll(async () => {
    server = await startMcpTestServer(testDb.db, [
      (app, deps) => registerMcpRoutes(app, deps, { path: "/mcp-test", tools: [echo] }),
    ]);
    userId = (await insertUser(testDb.db)).id;
  });

  afterAll(async () => {
    await server?.close();
  });

  const url = () => new URL("/mcp-test", server.origin);

  it("advertises the contract's schemas and runs the tool", async () => {
    const { secret } = await issueToken(server.deps, userId, ["mcp:read", "mcp:write"]);
    const client = await connectClient(url(), secret);
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      name: "test.echo",
      description: "Echo text back.",
      inputSchema: { type: "object", required: ["text"] },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: false },
    });

    const result = await client.callTool({ name: "test.echo", arguments: { text: "hi" } });
    expect(result.structuredContent).toEqual({ text: "hi" });
    expect(result.content).toEqual([{ type: "text", text: "Echo: hi" }]);
    await client.close();
  });

  it("rejects invalid input as a tool error", async () => {
    const { secret } = await issueToken(server.deps, userId, ["mcp:write"]);
    const response = await rpc(
      url(),
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "test.echo", arguments: { text: 7 } },
      },
      bearer(secret),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      result: { isError: boolean; content: { text: string }[] };
    };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0]?.text).toMatch(/Input validation error/);
  });
});
