import { randomBytes } from "node:crypto";
import { TOKEN_PREFIXES } from "@loomcast/contracts";
import { createTestDb, type TestDb } from "@loomcast/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AUTH_FAILURE_LIMIT } from "../../src/modules/auth/guards";
import { issueToken } from "../mcp-support";
import { createTestApp, errorCode, insertUser, login, send, testIp } from "../support";

/**
 * Every route a client reaches without valid credentials is rate limited: the public API routes,
 * the probes, and credentials that fail to verify on session, MCP and bearer routes.
 */

let testDb: TestDb;

beforeAll(async () => {
  testDb = await createTestDb();
});

afterAll(async () => {
  await testDb.drop();
});

/** A random secret in a token's format. Built at runtime so no credential-like literal exists. */
function fakeSecret(prefix: string): string {
  return `${prefix}${randomBytes(32).toString("base64url")}`;
}

/** A session cookie value that resolves to no session. */
function fakeSessionCookie(): string {
  return `lc_session=${randomBytes(32).toString("base64url")}`;
}

const MCP_PING = { jsonrpc: "2.0", id: 1, method: "ping" };
const MCP_ACCEPT = "application/json, text/event-stream";

describe("failed credentials", () => {
  it("limits invalid session cookies per address, then refuses before any lookup", async () => {
    const { app, clock } = createTestApp(testDb.db);
    const user = await insertUser(testDb.db);
    const ip = testIp(11);
    const { cookie } = await login(app, user.email, undefined, testIp(12));

    for (let i = 0; i < AUTH_FAILURE_LIMIT.capacity; i++) {
      const response = await send(app, "GET", "/api/auth/me", { cookie: fakeSessionCookie(), ip });
      expect(response.status, `attempt ${i + 1}`).toBe(401);
    }
    const blocked = await send(app, "GET", "/api/auth/me", { cookie: fakeSessionCookie(), ip });
    expect(blocked.status).toBe(429);
    expect(await errorCode(blocked)).toBe("rate_limited");
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);

    // Requests without credentials are not counted: a signed-out browser still gets 401.
    expect((await send(app, "GET", "/api/auth/me", { ip })).status).toBe(401);
    // Another address is unaffected, valid or not.
    expect((await send(app, "GET", "/api/auth/me", { cookie, ip: testIp(12) })).status).toBe(200);

    // The bucket refills over the interval.
    clock.advance(AUTH_FAILURE_LIMIT.intervalMs);
    expect((await send(app, "GET", "/api/auth/me", { cookie, ip })).status).toBe(200);
  });

  it("limits invalid bearer tokens on /mcp per address", async () => {
    const { app, deps } = createTestApp(testDb.db);
    const user = await insertUser(testDb.db);
    const valid = await issueToken(deps, user.id, ["mcp:read"]);
    const ip = testIp(21);
    const post = (secret: string, from: string) =>
      send(app, "POST", "/mcp", {
        body: MCP_PING,
        origin: null,
        ip: from,
        headers: { Authorization: `Bearer ${secret}`, Accept: MCP_ACCEPT },
      });

    for (let i = 0; i < AUTH_FAILURE_LIMIT.capacity; i++) {
      const prefix = i % 2 === 0 ? TOKEN_PREFIXES.mcp : TOKEN_PREFIXES.job;
      expect((await post(fakeSecret(prefix), ip)).status, `attempt ${i + 1}`).toBe(401);
    }
    const blocked = await post(fakeSecret(TOKEN_PREFIXES.mcp), ip);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).not.toBeNull();
    // Blocked before verification: even a valid token from that address waits.
    expect((await post(valid.secret, ip)).status).toBe(429);
    expect((await post(valid.secret, testIp(22))).status).toBe(200);
  });

  it("counts a token of another kind as a failed credential", async () => {
    const { app, deps } = createTestApp(testDb.db);
    const user = await insertUser(testDb.db);
    const device = await issueToken(deps, user.id, ["bridge"], "device");
    const ip = testIp(31);
    for (let i = 0; i < AUTH_FAILURE_LIMIT.capacity + 5; i++) {
      const response = await send(app, "POST", "/mcp", {
        body: MCP_PING,
        origin: null,
        ip,
        headers: { Authorization: `Bearer ${device.secret}`, Accept: MCP_ACCEPT },
      });
      // A device token is not an MCP token: refused, and counted as a failure.
      if (i < AUTH_FAILURE_LIMIT.capacity) {
        expect(response.status).toBe(401);
      } else {
        expect(response.status).toBe(429);
      }
    }
  });
});
