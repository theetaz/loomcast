import { randomUUID } from "node:crypto";
import {
  AccessTokenSchema,
  CreateTokenResponseSchema,
  DEVICE_TOKEN_RE,
  MCP_TOKEN_RE,
  type TokenKind,
  type TokenScope,
} from "@loomcast/contracts";
import { apiTokens, auditLog, users } from "@loomcast/db";
import { createTestDb, type TestDb } from "@loomcast/db/testing";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RegisterModule } from "../src/deps";
import { sha256Hex } from "../src/lib/crypto";
import { currentToken } from "../src/modules/auth/guards";
import { createTokensService, LAST_USED_RESOLUTION_MS } from "../src/modules/tokens/service";
import type { AppEnv } from "../src/types";
import { createTestApp, createTestClock, errorCode, insertUser, login, send } from "./support";

let testDb: TestDb;

beforeAll(async () => {
  testDb = await createTestDb();
});

afterAll(async () => {
  await testDb.drop();
});

/** Probe routes guarded the way the MCP and bridge modules will guard theirs. */
const probes: RegisterModule = (app, deps) => {
  const router = new Hono<AppEnv>();
  router.get("/probe/mcp", deps.auth.requireBearer("mcp"), (c) => c.json(currentToken(c)));
  router.post("/probe/mcp-write", deps.auth.requireBearer("mcp", ["mcp:write"]), (c) =>
    c.json({ ok: true }),
  );
  router.get("/probe/device", deps.auth.requireBearer("device", ["bridge"]), (c) =>
    c.json({ ok: true }),
  );
  app.route("/", router);
  return router;
};

async function createViaApi(cookie: string, body: unknown, app = createTestApp(testDb.db).app) {
  return send(app, "POST", "/api/tokens", { cookie, body });
}

function bearer(secret: string): Record<string, string> {
  return { Authorization: `Bearer ${secret}` };
}

describe("token endpoints", () => {
  it("creates an MCP token and returns the secret once", async () => {
    const { app } = createTestApp(testDb.db);
    const user = await insertUser(testDb.db);
    const { cookie } = await login(app, user.email);

    const response = await send(app, "POST", "/api/tokens", {
      cookie,
      body: { name: "Laptop", scopes: ["mcp:read", "mcp:write"] },
    });
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const created = CreateTokenResponseSchema.parse(await response.json());
    expect(created.secret).toMatch(MCP_TOKEN_RE);
    expect(created.token).toMatchObject({ kind: "mcp", name: "Laptop", revokedAt: null });
    expect(created.secret.startsWith(created.token.prefix)).toBe(true);
    expect(created.token.prefix).toHaveLength("lc_mcp_".length + 8);

    const [row] = await testDb.db
      .select()
      .from(apiTokens)
      .where(eq(apiTokens.id, created.token.id));
    expect(row?.tokenHash).toBe(sha256Hex(created.secret));
    expect(JSON.stringify(row)).not.toContain(created.secret);

    const list = await send(app, "GET", "/api/tokens", { cookie });
    expect(list.status).toBe(200);
    const text = await list.text();
    expect(text).not.toContain(created.secret);
    const items = (JSON.parse(text) as { items: unknown[] }).items.map((item) =>
      AccessTokenSchema.parse(item),
    );
    expect(items.map((item) => item.id)).toEqual([created.token.id]);

    const audits = await testDb.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "token.created"), eq(auditLog.targetId, created.token.id)));
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(audits[0])).not.toContain(created.secret);
  });

  it("reserves mcp:admin for the owner", async () => {
    const { app } = createTestApp(testDb.db);
    const admin = await insertUser(testDb.db, { role: "admin" });
    const owner = await insertUser(testDb.db, { role: "owner" });
    const adminSession = await login(app, admin.email);
    const ownerSession = await login(app, owner.email);
    const body = { name: "Admin tools", scopes: ["mcp:admin"] };

    const refused = await createViaApi(adminSession.cookie, body, app);
    expect(refused.status).toBe(403);
    const allowed = await createViaApi(ownerSession.cookie, body, app);
    expect(allowed.status).toBe(201);
  });

  it("validates names, scopes and expiry", async () => {
    const { app } = createTestApp(testDb.db);
    const user = await insertUser(testDb.db);
    const { cookie } = await login(app, user.email);
    for (const body of [
      { name: "", scopes: ["mcp:read"] },
      { name: "x", scopes: [] },
      { name: "x", scopes: ["bridge"] },
      { name: "x", scopes: ["mcp:read", "mcp:read"] },
      { name: "x", scopes: ["mcp:read"], expiresAt: "2001-01-01T00:00:00.000Z" },
    ]) {
      const response = await createViaApi(cookie, body, app);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(await errorCode(response)).toBe("validation_failed");
    }
  });

  it("revokes only the caller's own MCP tokens", async () => {
    const { app, deps } = createTestApp(testDb.db);
    const user = await insertUser(testDb.db);
    const other = await insertUser(testDb.db);
    const { cookie } = await login(app, user.email);
    const tokens = createTokensService(deps);
    const mine = await tokens.create({
      userId: user.id,
      kind: "mcp",
      name: "a",
      scopes: ["mcp:read"],
    });
    const theirs = await tokens.create({
      userId: other.id,
      kind: "mcp",
      name: "b",
      scopes: ["mcp:read"],
    });
    const device = await tokens.create({
      userId: user.id,
      kind: "device",
      name: "Mac",
      scopes: ["bridge"],
    });

    expect((await send(app, "DELETE", `/api/tokens/${theirs.row.id}`, { cookie })).status).toBe(
      404,
    );
    expect((await send(app, "DELETE", `/api/tokens/${device.row.id}`, { cookie })).status).toBe(
      404,
    );
    expect((await send(app, "DELETE", `/api/tokens/${randomUUID()}`, { cookie })).status).toBe(404);
    expect((await send(app, "DELETE", "/api/tokens/not-a-uuid", { cookie })).status).toBe(404);

    expect((await send(app, "DELETE", `/api/tokens/${mine.row.id}`, { cookie })).status).toBe(204);
    // Revoking again is harmless.
    expect((await send(app, "DELETE", `/api/tokens/${mine.row.id}`, { cookie })).status).toBe(204);
    expect(await tokens.verify(mine.secret, "mcp")).toBeNull();
    expect(await tokens.verify(theirs.secret, "mcp")).not.toBeNull();

    const list = await send(app, "GET", "/api/tokens", { cookie });
    expect(((await list.json()) as { items: unknown[] }).items).toHaveLength(0);
  });

  it("needs a session and never accepts a bearer token", async () => {
    const { app, deps } = createTestApp(testDb.db);
    const user = await insertUser(testDb.db);
    const token = await createTokensService(deps).create({
      userId: user.id,
      kind: "mcp",
      name: "cli",
      scopes: ["mcp:read", "mcp:write"],
    });
    const response = await send(app, "GET", "/api/tokens", { headers: bearer(token.secret) });
    expect(response.status).toBe(401);
  });
});

describe("tokens service", () => {
  it("verifies by kind, expiry, revocation and account state", async () => {
    const clock = createTestClock();
    const tokens = createTokensService({ db: testDb.db, clock });
    const user = await insertUser(testDb.db);

    const device = await tokens.create({
      userId: user.id,
      kind: "device",
      name: "Mac",
      scopes: ["bridge"],
    });
    expect(device.secret).toMatch(DEVICE_TOKEN_RE);
    expect(await tokens.verify(device.secret, "device")).toMatchObject({
      id: device.row.id,
      kind: "device",
      scopes: ["bridge"],
      user: { id: user.id },
    });
    expect(await tokens.verify(device.secret, "mcp")).toBeNull();
    // Change the last character to a different one; a fixed "x" would leave the secret unchanged when
    // the random secret already ends in "x" (about one run in 62).
    const tampered = `${device.secret.slice(0, -1)}${device.secret.endsWith("x") ? "y" : "x"}`;
    expect(await tokens.verify(tampered, "device")).toBeNull();
    expect(await tokens.verify("lc_dev_short", "device")).toBeNull();

    const expiring = await tokens.create({
      userId: user.id,
      kind: "mcp",
      name: "short-lived",
      scopes: ["mcp:read"],
      expiresAt: new Date(clock.now().getTime() + 60_000),
    });
    expect(await tokens.verify(expiring.secret, "mcp")).not.toBeNull();
    clock.advance(60_000);
    expect(await tokens.verify(expiring.secret, "mcp")).toBeNull();

    const revoked = await tokens.revoke(device.row.id);
    expect(revoked?.revoked).toBe(true);
    expect(await tokens.verify(device.secret, "device")).toBeNull();

    const live = await tokens.create({
      userId: user.id,
      kind: "mcp",
      name: "x",
      scopes: ["mcp:read"],
    });
    await testDb.db.update(users).set({ disabledAt: clock.now() }).where(eq(users.id, user.id));
    expect(await tokens.verify(live.secret, "mcp")).toBeNull();
  });

  it("writes last_used_at at most once a minute", async () => {
    const clock = createTestClock();
    const tokens = createTokensService({ db: testDb.db, clock });
    const user = await insertUser(testDb.db);
    const created = await tokens.create({
      userId: user.id,
      kind: "mcp",
      name: "x",
      scopes: ["mcp:read"],
    });
    const lastUsed = async () => {
      const [row] = await testDb.db
        .select({ lastUsedAt: apiTokens.lastUsedAt })
        .from(apiTokens)
        .where(eq(apiTokens.id, created.row.id));
      return row?.lastUsedAt?.getTime() ?? null;
    };

    expect(await lastUsed()).toBeNull();
    const first = clock.now().getTime();
    await tokens.verify(created.secret, "mcp");
    expect(await lastUsed()).toBe(first);

    clock.advance(LAST_USED_RESOLUTION_MS - 1);
    await tokens.verify(created.secret, "mcp");
    expect(await lastUsed()).toBe(first);

    clock.advance(1);
    await tokens.verify(created.secret, "mcp");
    expect(await lastUsed()).toBe(clock.now().getTime());
  });

  it("drops mcp:admin when the account is no longer the owner", async () => {
    const clock = createTestClock();
    const tokens = createTokensService({ db: testDb.db, clock });
    const owner = await insertUser(testDb.db, {
      role: "owner",
      email: `own-${randomUUID()}@x.test`,
    });
    const created = await tokens.create({
      userId: owner.id,
      kind: "mcp",
      name: "admin",
      scopes: ["mcp:read", "mcp:admin"],
    });
    expect((await tokens.verify(created.secret, "mcp"))?.scopes).toEqual(["mcp:read", "mcp:admin"]);
    await testDb.db.update(users).set({ role: "admin" }).where(eq(users.id, owner.id));
    expect((await tokens.verify(created.secret, "mcp"))?.scopes).toEqual(["mcp:read"]);
  });

  it("refuses scopes that do not suit the kind", async () => {
    const tokens = createTokensService({ db: testDb.db, clock: createTestClock() });
    const user = await insertUser(testDb.db);
    const cases: Array<{ kind: TokenKind; scopes: TokenScope[] }> = [
      { kind: "mcp", scopes: ["bridge"] },
      { kind: "device", scopes: ["mcp:read"] },
      { kind: "device", scopes: [] },
    ];
    for (const input of cases) {
      await expect(tokens.create({ userId: user.id, name: "x", ...input })).rejects.toMatchObject({
        status: 400,
      });
    }
  });
});

describe("requireBearer", () => {
  it("authenticates by bearer token and enforces scopes", async () => {
    const { app, deps } = createTestApp(testDb.db, { modules: [probes] });
    const user = await insertUser(testDb.db);
    const tokens = createTokensService(deps);
    const reader = await tokens.create({
      userId: user.id,
      kind: "mcp",
      name: "r",
      scopes: ["mcp:read"],
    });
    const writer = await tokens.create({
      userId: user.id,
      kind: "mcp",
      name: "w",
      scopes: ["mcp:read", "mcp:write"],
    });
    const device = await tokens.create({
      userId: user.id,
      kind: "device",
      name: "d",
      scopes: ["bridge"],
    });

    const ok = await send(app, "GET", "/probe/mcp", { headers: bearer(reader.secret) });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ id: reader.row.id, scopes: ["mcp:read"] });

    const readOnly = await send(app, "POST", "/probe/mcp-write", {
      headers: bearer(reader.secret),
      origin: null,
    });
    expect(readOnly.status).toBe(403);
    expect(readOnly.headers.get("www-authenticate")).toContain("insufficient_scope");

    const write = await send(app, "POST", "/probe/mcp-write", {
      headers: bearer(writer.secret),
      origin: null,
    });
    expect(write.status).toBe(200);

    // A device token is not an MCP token, and the other way round.
    expect((await send(app, "GET", "/probe/mcp", { headers: bearer(device.secret) })).status).toBe(
      401,
    );
    expect(
      (await send(app, "GET", "/probe/device", { headers: bearer(writer.secret) })).status,
    ).toBe(401);
    expect(
      (await send(app, "GET", "/probe/device", { headers: bearer(device.secret) })).status,
    ).toBe(200);

    await tokens.revoke(reader.row.id);
    const revoked = await send(app, "GET", "/probe/mcp", { headers: bearer(reader.secret) });
    expect(revoked.status).toBe(401);
    expect(revoked.headers.get("www-authenticate")).toContain("invalid_token");
  });

  it("rejects missing and malformed credentials and ignores cookies", async () => {
    const { app } = createTestApp(testDb.db, { modules: [probes] });
    const user = await insertUser(testDb.db);
    const { cookie } = await login(app, user.email);

    const missing = await send(app, "GET", "/probe/mcp");
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toContain("Bearer");

    expect((await send(app, "GET", "/probe/mcp", { cookie })).status).toBe(401);
    for (const authorization of ["Basic abc", "Bearer", "Bearer a b", "lc_mcp_x"]) {
      const response = await send(app, "GET", "/probe/mcp", {
        headers: { Authorization: authorization },
      });
      expect(response.status, authorization).toBe(401);
    }
  });
});
