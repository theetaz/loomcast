import { randomUUID } from "node:crypto";
import { workspaces } from "@loomcast/db";
import { createTestDb, type TestDb } from "@loomcast/db/testing";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generatePrefixedToken } from "../src/lib/crypto";
import { MCP_JOB_RATE_LIMIT, MCP_RATE_LIMIT, MCP_SERVER_NAME } from "../src/modules/mcp";
import { createTokensService } from "../src/modules/tokens/service";
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

let testDb: TestDb;
let server: McpTestServer;
let userId: string;
let userEmail: string;

beforeAll(async () => {
  testDb = await createTestDb();
  server = await startMcpTestServer(testDb.db);
  const user = await insertUser(testDb.db, { role: "owner" });
  userId = user.id;
  userEmail = user.email;
});

afterAll(async () => {
  await server?.close();
  await testDb?.drop();
});

const ping = { jsonrpc: "2.0", id: 1, method: "ping" };

async function expectConnectFails(secret: string | undefined, status: number) {
  const error = await connectClient(server.url, secret).then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(StreamableHTTPError);
  expect((error as StreamableHTTPError).code).toBe(status);
}

describe("mcp endpoint", () => {
  it("lets a client with a valid token initialize", async () => {
    const { secret } = await issueToken(server.deps, userId, ["mcp:read"]);
    const client = await connectClient(server.url, secret);
    expect(client.getServerVersion()?.name).toBe(MCP_SERVER_NAME);
    expect(client.getInstructions()).toContain("workspace.list");
    await client.ping();
    await client.close();
  });

  it("is stateless: no session id, and GET and DELETE are not offered", async () => {
    const { secret } = await issueToken(server.deps, userId, ["mcp:read"]);
    const initialize = await rpc(
      server.url,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "probe", version: "0.0.0" },
        },
      },
      bearer(secret),
    );
    expect(initialize.status).toBe(200);
    expect(initialize.headers.get("mcp-session-id")).toBeNull();
    expect(initialize.headers.get("content-type")).toContain("application/json");

    for (const method of ["GET", "DELETE"]) {
      const response = await rpc(server.url, undefined, bearer(secret), method);
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("POST");
    }
  });

  it("answers 401 without a bearer token", async () => {
    const response = await rpc(server.url, ping);
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Bearer");
    await expectConnectFails(undefined, 401);
  });

  it("ignores the session cookie", async () => {
    const { cookie } = await login(server.running.app, userEmail);
    const response = await rpc(server.url, ping, { Cookie: cookie });
    expect(response.status).toBe(401);
  });

  it("refuses unknown, device and job-shaped tokens", async () => {
    const unknown = generatePrefixedToken("mcp").secret;
    const device = await issueToken(server.deps, userId, ["bridge"], "device");
    const job = generatePrefixedToken("job").secret;
    for (const secret of [unknown, device.secret, job, randomUUID()]) {
      const response = await rpc(server.url, ping, bearer(secret));
      expect(response.status).toBe(401);
    }
  });

  it("rejects a revoked token", async () => {
    const { secret, row } = await issueToken(server.deps, userId, ["mcp:read"]);
    const client = await connectClient(server.url, secret);
    await client.ping();
    await createTokensService(server.deps).revoke(row.id);

    await expect(client.ping()).rejects.toMatchObject({ code: 401 });
    await client.close();
    await expectConnectFails(secret, 401);
  });

  it("refuses requests from another origin", async () => {
    const { secret } = await issueToken(server.deps, userId, ["mcp:read"]);
    const foreign = await rpc(server.url, ping, {
      ...bearer(secret),
      Origin: "https://elsewhere.example.test",
    });
    expect(foreign.status).toBe(403);
    const own = await rpc(server.url, ping, { ...bearer(secret), Origin: APP_ORIGIN });
    expect(own.status).toBe(200);
  });

  it("limits each token to 120 requests a minute", async () => {
    const limited = await issueToken(server.deps, userId, ["mcp:read"]);
    const other = await issueToken(server.deps, userId, ["mcp:read"]);
    for (let i = 0; i < MCP_RATE_LIMIT.capacity; i += 1) {
      const response = await rpc(server.url, ping, bearer(limited.secret));
      expect(response.status).toBe(200);
    }
    const refused = await rpc(server.url, ping, bearer(limited.secret));
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("1");

    const unaffected = await rpc(server.url, ping, bearer(other.secret));
    expect(unaffected.status).toBe(200);

    server.clock.advance(MCP_RATE_LIMIT.intervalMs / MCP_RATE_LIMIT.capacity);
    const refilled = await rpc(server.url, ping, bearer(limited.secret));
    expect(refilled.status).toBe(200);
  });

  it("limits each job token to 240 requests a minute", async () => {
    expect(MCP_JOB_RATE_LIMIT.capacity).toBe(240);
    const [workspace] = await testDb.db
      .insert(workspaces)
      .values({ slug: `limit-${randomUUID().slice(0, 8)}`, name: "Limits", createdBy: userId })
      .returning();
    if (workspace === undefined) {
      throw new Error("workspace was not inserted");
    }
    const scopes = ["mcp:read"] as const;
    const limited = await issueJobToken(testDb.db, { userId, workspaceId: workspace.id, scopes });
    const other = await issueJobToken(testDb.db, { userId, workspaceId: workspace.id, scopes });
    for (let i = 0; i < MCP_JOB_RATE_LIMIT.capacity; i += 1) {
      const response = await rpc(server.url, ping, bearer(limited.secret));
      expect(response.status).toBe(200);
    }
    const refused = await rpc(server.url, ping, bearer(limited.secret));
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("1");

    const unaffected = await rpc(server.url, ping, bearer(other.secret));
    expect(unaffected.status).toBe(200);
  });
});
