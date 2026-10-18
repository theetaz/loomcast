import { buildPath, type PathParams, type RouteName, routes } from "@loomcast/contracts";
import { createTestDb, type TestDb } from "@loomcast/db/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createApiClientsService } from "../../src/modules/api-clients";
import {
  type BridgeServer,
  FakeAgent,
  pairDevice,
  seedProject,
  startBridgeServer,
  UpgradeRefused,
} from "../bridge-support";
import { issueJobToken, issueToken } from "../mcp-support";
import { insertChannel, testKeyring } from "../publisher-support";
import { createTestApp, insertUser, login, send, testIp } from "../support";

/**
 * Cookies and bearer tokens never stand in for each other: `/mcp`, `/bridge` and `/api/v1` read
 * only bearer tokens (of their own kinds), and the cookie routes read only the session cookie.
 */

const SAMPLE_ID = "00000000-0000-4000-8000-000000000000";
const MCP_PING = { jsonrpc: "2.0", id: 1, method: "ping" };
const MCP_ACCEPT = "application/json, text/event-stream";

let testDb: TestDb;
const servers: BridgeServer[] = [];

beforeAll(async () => {
  testDb = await createTestDb();
});

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await server.close();
  }
});

afterAll(async () => {
  await testDb.drop();
});

function samplePath(path: string): string {
  const params = Object.fromEntries(
    [...path.matchAll(/:([A-Za-z0-9_]+)/g)].map((match) => [match[1], SAMPLE_ID]),
  ) as PathParams<string>;
  return buildPath(path, params);
}

describe("/mcp reads bearer tokens only", () => {
  it("refuses a valid session cookie without a bearer token", async () => {
    const { app } = createTestApp(testDb.db);
    const user = await insertUser(testDb.db);
    const { cookie } = await login(app, user.email, undefined, testIp(1));
    const response = await send(app, "POST", "/mcp", {
      body: MCP_PING,
      cookie,
      headers: { Accept: MCP_ACCEPT },
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Bearer");
  });

  it("refuses the session secret sent as a bearer token", async () => {
    const { app } = createTestApp(testDb.db);
    const user = await insertUser(testDb.db);
    const { cookie } = await login(app, user.email, undefined, testIp(2));
    const secret = cookie.slice(cookie.indexOf("=") + 1);
    const response = await send(app, "POST", "/mcp", {
      body: MCP_PING,
      headers: { Authorization: `Bearer ${secret}`, Accept: MCP_ACCEPT },
    });
    expect(response.status).toBe(401);
  });

  it("refuses a device token", async () => {
    const { app, deps } = createTestApp(testDb.db);
    const user = await insertUser(testDb.db);
    const device = await issueToken(deps, user.id, ["bridge"], "device");
    const response = await send(app, "POST", "/mcp", {
      body: MCP_PING,
      headers: { Authorization: `Bearer ${device.secret}`, Accept: MCP_ACCEPT },
    });
    expect(response.status).toBe(401);
  });
});

describe("/bridge reads device tokens only", () => {
  it("refuses an upgrade that carries only a session cookie", async () => {
    const server = await startBridgeServer(testDb.db);
    servers.push(server);
    const user = await insertUser(testDb.db);
    const { cookie } = await login(server.app, user.email, undefined, testIp(3));
    const refused = await FakeAgent.connect(server.port, { headers: { cookie } }).catch(
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(UpgradeRefused);
    expect((refused as UpgradeRefused).status).toBe(401);
  });

  it("refuses an MCP token and accepts a device token", async () => {
    const server = await startBridgeServer(testDb.db);
    servers.push(server);
    const user = await insertUser(testDb.db);
    const mcp = await issueToken(server.deps, user.id, ["mcp:read", "mcp:write"]);
    const refused = await FakeAgent.connect(server.port, { secret: mcp.secret }).catch(
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(UpgradeRefused);
    expect((refused as UpgradeRefused).status).toBe(401);

    const device = await pairDevice(testDb.db, user.id);
    const agent = await FakeAgent.connect(server.port, { secret: device.secret });
    agent.ws.terminate();
  });
});

describe("cookie routes read the session cookie only", () => {
  const sessionRoutes = (Object.keys(routes) as RouteName[]).filter(
    (name) => routes[name].auth === "session",
  );

  it("refuses MCP, job and device tokens on every session route", async () => {
    const { app, deps } = createTestApp(testDb.db);
    const fixtures = await seedProject(testDb.db);
    const mcp = await issueToken(deps, fixtures.userId, ["mcp:read", "mcp:write"]);
    const device = await issueToken(deps, fixtures.userId, ["bridge"], "device");
    const job = await issueJobToken(testDb.db, {
      userId: fixtures.userId,
      projectId: fixtures.projectId,
      scopes: ["mcp:read", "mcp:write"],
    });
    const secrets = { mcp: mcp.secret, device: device.secret, job: job.secret };

    expect(sessionRoutes.length).toBeGreaterThan(80);
    for (const name of sessionRoutes) {
      const route = routes[name];
      for (const [kind, secret] of Object.entries(secrets)) {
        const response = await send(app, route.method, samplePath(route.path), {
          body: route.method === "GET" || route.method === "DELETE" ? undefined : {},
          headers: { Authorization: `Bearer ${secret}` },
        });
        expect(response.status, `${name} with a ${kind} token`).toBe(401);
      }
    }
  });
});

describe("the machine API reads API keys only", () => {
  const machineRoutes = (Object.keys(routes) as RouteName[]).filter(
    (name) => routes[name].auth === "api_key",
  );
  const sessionRoutes = (Object.keys(routes) as RouteName[]).filter(
    (name) => routes[name].auth === "session",
  );

  it("refuses MCP, job and device tokens on /api/v1 and API keys on the cookie routes", async () => {
    const { app, deps } = createTestApp(testDb.db);
    const fixtures = await seedProject(testDb.db);
    const owner = await insertUser(testDb.db, { role: "owner" });
    const channel = await insertChannel(testDb.db, testKeyring(), { platform: "facebook" });
    const client = await createApiClientsService(deps).create(
      {
        name: "Backend",
        projectId: fixtures.projectId,
        grants: [{ channelId: channel.id, access: "publish" }],
      },
      owner.id,
    );
    const mcp = await issueToken(deps, fixtures.userId, ["mcp:read", "mcp:write"]);
    const device = await issueToken(deps, fixtures.userId, ["bridge"], "device");
    const job = await issueJobToken(testDb.db, {
      userId: fixtures.userId,
      projectId: fixtures.projectId,
      scopes: ["mcp:read", "mcp:write"],
    });
    const others = { mcp: mcp.secret, device: device.secret, job: job.secret };

    for (const name of machineRoutes) {
      const route = routes[name];
      for (const [index, [kind, secret]] of Object.entries(others).entries()) {
        // One address per kind keeps the failures under the auth-failure limit.
        const response = await send(app, route.method, samplePath(route.path), {
          ip: testIp(20 + index),
          origin: null,
          body: route.method === "GET" ? undefined : {},
          headers: { Authorization: `Bearer ${secret}` },
        });
        expect(response.status, `${name} with a ${kind} token`).toBe(401);
      }
    }
    for (const name of sessionRoutes) {
      const route = routes[name];
      const response = await send(app, route.method, samplePath(route.path), {
        body: route.method === "GET" || route.method === "DELETE" ? undefined : {},
        headers: { Authorization: `Bearer ${client.secret}` },
      });
      expect(response.status, `${name} with an API key`).toBe(401);
    }
    const mcpCall = await send(app, "POST", "/mcp", {
      body: MCP_PING,
      headers: { Accept: MCP_ACCEPT, Authorization: `Bearer ${client.secret}` },
    });
    expect(mcpCall.status).toBe(401);
  });
});
