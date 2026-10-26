import { randomUUID } from "node:crypto";
import { AdminCreateUserOutputSchema, type TokenScope } from "@loomcast/contracts";
import { apiTokens, auditLog, users, workspaces } from "@loomcast/db";
import { createTestDb, type TestDb } from "@loomcast/db/testing";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generatePrefixedToken } from "../src/lib/crypto";
import { createAdminTools, type McpCaller, TOOL_CALL_AUDIT_ACTION } from "../src/modules/mcp";
import {
  bearer,
  connectClient,
  issueJobToken,
  issueToken,
  type McpTestServer,
  rpc,
  startMcpTestServer,
} from "./mcp-support";
import { APP_ORIGIN, insertUser, testIp } from "./support";

type CallResult = Awaited<ReturnType<Client["callTool"]>>;

let testDb: TestDb;
let server: McpTestServer;
let ownerId: string;
let owner: Client;
let ownerTokenId: string;
let ownerSecret: string;
const clients: Client[] = [];

beforeAll(async () => {
  testDb = await createTestDb();
  server = await startMcpTestServer(testDb.db);
  ownerId = (await insertUser(testDb.db, { role: "owner" })).id;
  const issued = await issueToken(server.deps, ownerId, ["mcp:read", "mcp:write", "mcp:admin"]);
  ownerTokenId = issued.row.id;
  ownerSecret = issued.secret;
  owner = await connectClient(server.url, ownerSecret);
});

afterAll(async () => {
  for (const client of [owner, ...clients]) {
    await client?.close();
  }
  await server?.close();
  await testDb?.drop();
});

function textOf(result: CallResult): string {
  const [first] = result.content as { type: string; text: string }[];
  return first?.text ?? "";
}

function newEmail(): string {
  return `invitee-${randomUUID().slice(0, 8)}@example.test`;
}

async function userByEmail(email: string) {
  const [row] = await testDb.db.select().from(users).where(eq(users.email, email));
  return row;
}

/**
 * A token stored with `scopes` as they are, the way a token issued before its user lost the owner
 * role would be. The secret is generated, never written in a test.
 */
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

describe("admin.create_user", () => {
  it("lets the owner invite a user and returns the link only as structured content", async () => {
    const email = newEmail();
    const result = await owner.callTool({
      name: "admin.create_user",
      arguments: { email, name: "New Admin", role: "admin" },
    });
    expect(result.isError, textOf(result)).toBeFalsy();
    const output = AdminCreateUserOutputSchema.parse(result.structuredContent);
    expect(output.setPasswordUrl.startsWith(`${APP_ORIGIN}/set-password#token=`)).toBe(true);
    expect(new Date(output.expiresAt).getTime()).toBeGreaterThan(Date.now());

    const text = textOf(result);
    expect(text).toContain(output.userId);
    expect(text).not.toContain(output.setPasswordUrl);
    expect(text).not.toContain("token=");
    expect(text).not.toContain("http");

    expect(await userByEmail(email)).toMatchObject({
      id: output.userId,
      name: "New Admin",
      role: "admin",
      passwordHash: null,
      disabledAt: null,
    });

    const audits = await testDb.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.actorKind, "token"), eq(auditLog.actorId, ownerTokenId)));
    const invited = audits.find((row) => row.action === "user.invited");
    expect(invited).toMatchObject({ targetId: output.userId, data: { email, via: "mcp" } });
    expect(JSON.stringify(invited?.data)).not.toContain("token=");
    expect(audits).toContainEqual(
      expect.objectContaining({
        action: TOOL_CALL_AUDIT_ACTION,
        targetId: "admin.create_user",
        data: { outcome: "ok" },
      }),
    );
  });

  it("keeps responses out of caches", async () => {
    const response = await rpc(
      server.url,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "admin.create_user",
          arguments: { email: newEmail(), name: "Cached", role: "admin" },
        },
      },
      bearer(ownerSecret),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("reports a taken email and refuses a second owner", async () => {
    const email = newEmail();
    await owner.callTool({
      name: "admin.create_user",
      arguments: { email, name: "First", role: "admin" },
    });
    const again = await owner.callTool({
      name: "admin.create_user",
      arguments: { email, name: "Second", role: "admin" },
    });
    expect(again.isError).toBe(true);
    expect(textOf(again)).toBe("conflict: An account with this email already exists.");

    const ownerRole = await owner.callTool({
      name: "admin.create_user",
      arguments: { email: newEmail(), name: "Another owner", role: "owner" },
    });
    expect(ownerRole.isError).toBe(true);
    expect(textOf(ownerRole)).toMatch(/^validation_failed: Only admins can be invited\./);
  });

  it("refuses tokens without mcp:admin", async () => {
    const plain = await connectClient(
      server.url,
      (await issueToken(server.deps, ownerId, ["mcp:read", "mcp:write"])).secret,
    );
    clients.push(plain);
    const email = newEmail();
    const result = await plain.callTool({
      name: "admin.create_user",
      arguments: { email, name: "Nope", role: "admin" },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/^forbidden: .*mcp:admin/);
    expect(await userByEmail(email)).toBeUndefined();
  });

  it("refuses an admin token of a user who is not the owner", async () => {
    const admin = await insertUser(testDb.db, { role: "admin" });
    // Stored with mcp:admin, which verification drops for anyone but the owner.
    const client = await connectClient(
      server.url,
      await storedToken(admin.id, ["mcp:read", "mcp:write", "mcp:admin"]),
    );
    clients.push(client);
    const email = newEmail();
    const result = await client.callTool({
      name: "admin.create_user",
      arguments: { email, name: "Nope", role: "admin" },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/^forbidden: .*mcp:admin/);
    expect(await userByEmail(email)).toBeUndefined();

    // The tool checks the owner itself too, whatever scopes the caller carries.
    const [tool] = createAdminTools({
      users: {
        invite: () => {
          throw new Error("must not be called");
        },
      },
    });
    const caller: McpCaller = {
      token: {
        id: randomUUID(),
        kind: "mcp",
        name: "admin token",
        scopes: ["mcp:admin"],
        user: { id: admin.id, email: admin.email, name: admin.name, role: "admin" },
      },
      boundWorkspaceId: null,
      jobId: null,
      ip: testIp(4),
    };
    const direct = await tool?.run(
      { email: newEmail(), name: "Nope", role: "admin" },
      { caller, logger: server.deps.logger, db: testDb.db },
    );
    expect(direct?.isError).toBe(true);
    expect(textOf(direct as CallResult)).toBe("forbidden: Only the owner can create users.");
  });

  it("refuses job tokens, even the owner's", async () => {
    const [workspace] = await testDb.db
      .insert(workspaces)
      .values({ slug: `admin-${randomUUID().slice(0, 8)}`, name: "Admin", createdBy: ownerId })
      .returning();
    if (workspace === undefined) {
      throw new Error("workspace was not inserted");
    }
    const { secret } = await issueJobToken(testDb.db, {
      userId: ownerId,
      workspaceId: workspace.id,
      scopes: ["mcp:read", "mcp:write", "mcp:admin"],
    });
    const client = await connectClient(server.url, secret);
    clients.push(client);
    const email = newEmail();
    for (const call of [
      { name: "admin.create_user", arguments: { email, name: "Nope", role: "admin" } },
      { name: "workspace.create", arguments: { name: "From a job" } },
    ]) {
      const result = await client.callTool(call);
      expect(result.isError, call.name).toBe(true);
      expect(textOf(result), call.name).toBe("forbidden: Job tokens cannot call this tool.");
    }
    expect(await userByEmail(email)).toBeUndefined();
  });
});
