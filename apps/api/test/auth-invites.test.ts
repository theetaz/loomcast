import { randomBytes, randomUUID } from "node:crypto";
import {
  InviteUserResponseSchema,
  PASSWORD_TOKEN_RE,
  PASSWORD_TOKEN_TTL_MS,
  PasswordTokenInfoSchema,
  UserSummarySchema,
} from "@loomcast/contracts";
import { apiTokens, auditLog, jobs, passwordTokens, projects, sessions, users } from "@loomcast/db";
import { createTestDb, type TestDb } from "@loomcast/db/testing";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sha256Hex } from "../src/lib/crypto";
import { PASSWORD_LINK_LIMIT } from "../src/modules/auth";
import { createTokensService } from "../src/modules/tokens/service";
import {
  APP_ORIGIN,
  createTestApp,
  errorCode,
  insertUser,
  login,
  send,
  sessionCookie,
  type TestApp,
  testIp,
  testPassword,
} from "./support";

let testDb: TestDb;
let ip = 0;

beforeAll(async () => {
  testDb = await createTestDb();
});

afterAll(async () => {
  await testDb.drop();
});

/** A fresh client address per request, so the per-address limits never interfere. */
function nextIp(): string {
  ip = (ip % 250) + 1;
  return testIp(ip);
}

/** The owner of a fresh app, signed in. Each test gets its own owner-less database state. */
async function ownerApp(): Promise<{ test: TestApp; ownerId: string; cookie: string }> {
  await testDb.db.delete(jobs);
  await testDb.db.delete(projects);
  await testDb.db.delete(apiTokens);
  await testDb.db.delete(users);
  const test = createTestApp(testDb.db);
  const owner = await insertUser(testDb.db, { role: "owner" });
  const { cookie } = await login(test.app, owner.email, undefined, nextIp());
  return { test, ownerId: owner.id, cookie };
}

function uniqueEmail(label: string): string {
  return `${label}-${randomUUID()}@example.test`;
}

/** The raw token in a set-password link's fragment. */
function tokenFrom(url: string): string {
  const parsed = new URL(url);
  expect(`${parsed.origin}${parsed.pathname}`).toBe(`${APP_ORIGIN}/set-password`);
  expect(parsed.search).toBe("");
  const token = new URLSearchParams(parsed.hash.slice(1)).get("token") ?? "";
  expect(token).toMatch(PASSWORD_TOKEN_RE);
  return token;
}

async function invite(test: TestApp, cookie: string, email = uniqueEmail("invitee")) {
  const response = await send(test.app, "POST", "/api/users/invitations", {
    cookie,
    body: { email, name: "Invitee", role: "admin" },
  });
  expect(response.status).toBe(201);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const body = InviteUserResponseSchema.parse(await response.json());
  return { ...body, token: tokenFrom(body.setPasswordUrl) };
}

function inspect(test: TestApp, token: string, options: { ip?: string } = {}) {
  return send(test.app, "POST", "/api/auth/password-tokens/inspect", {
    body: { token },
    ip: options.ip ?? nextIp(),
  });
}

function setPassword(
  test: TestApp,
  token: string,
  newPassword: string,
  options: { ip?: string; origin?: string | null } = {},
) {
  return send(test.app, "POST", "/api/auth/set-password", {
    body: { token, newPassword },
    ip: options.ip ?? nextIp(),
    origin: options.origin,
  });
}

/** A well-formed set-password token that was never issued. */
function unknownToken(): string {
  return randomBytes(32).toString("base64url");
}

async function auditActions(targetId: string): Promise<string[]> {
  const rows = await testDb.db.select().from(auditLog).where(eq(auditLog.targetId, targetId));
  return rows.map((row) => row.action);
}

describe("invitations", () => {
  it("invites, inspects, sets the password and then signs in", async () => {
    const { test, ownerId, cookie } = await ownerApp();
    const email = uniqueEmail("new");
    const invited = await invite(test, cookie, email);

    expect(invited.user).toMatchObject({ email, role: "admin", disabledAt: null });
    expect(invited.expiresAt).toBe(
      new Date(test.clock.now().getTime() + PASSWORD_TOKEN_TTL_MS.invite).toISOString(),
    );
    const [stored] = await testDb.db.select().from(users).where(eq(users.id, invited.user.id));
    expect(stored?.passwordHash).toBeNull();
    const links = await testDb.db
      .select()
      .from(passwordTokens)
      .where(eq(passwordTokens.userId, invited.user.id));
    expect(links).toHaveLength(1);
    // Only the hash is stored.
    expect(links[0]).toMatchObject({
      tokenHash: sha256Hex(invited.token),
      purpose: "invite",
      createdBy: ownerId,
      usedAt: null,
    });
    expect(JSON.stringify(links)).not.toContain(invited.token);

    // Without a password the account cannot sign in yet.
    const early = await send(test.app, "POST", "/api/auth/login", {
      body: { email, password: testPassword("guess") },
      ip: nextIp(),
    });
    expect(early.status).toBe(401);

    const inspected = await inspect(test, invited.token);
    expect(inspected.status).toBe(200);
    expect(PasswordTokenInfoSchema.parse(await inspected.json())).toEqual({
      email,
      purpose: "invite",
      expiresAt: invited.expiresAt,
    });

    const chosen = testPassword("chosen");
    const set = await setPassword(test, invited.token, chosen);
    expect(set.status).toBe(204);
    // No automatic sign-in.
    expect(sessionCookie(set)).toBeNull();

    const { response } = await login(test.app, email, chosen, nextIp());
    expect(response.status).toBe(200);

    expect(await auditActions(invited.user.id)).toEqual(
      expect.arrayContaining([
        "user.invited",
        "auth.password_token.inspected",
        "auth.password.set",
        "auth.login.succeeded",
      ]),
    );
    // Neither the link nor the token ever reached a log line or an audit row.
    const logged = test.logs.join("\n");
    expect(logged).not.toContain(invited.token);
    const audits = await testDb.db.select().from(auditLog);
    expect(JSON.stringify(audits)).not.toContain(invited.token);
  });

  it("refuses a used link", async () => {
    const { test, cookie } = await ownerApp();
    const invited = await invite(test, cookie);
    expect((await setPassword(test, invited.token, testPassword("first"))).status).toBe(204);

    const again = await setPassword(test, invited.token, testPassword("second"));
    expect(again.status).toBe(404);
    expect(await errorCode(again)).toBe("not_found");
    expect((await inspect(test, invited.token)).status).toBe(404);
  });

  it("refuses an expired link", async () => {
    const { test, cookie } = await ownerApp();
    const invited = await invite(test, cookie);
    test.clock.advance(PASSWORD_TOKEN_TTL_MS.invite - 1);
    expect((await inspect(test, invited.token)).status).toBe(200);

    test.clock.advance(1);
    expect((await inspect(test, invited.token)).status).toBe(404);
    expect((await setPassword(test, invited.token, testPassword("late"))).status).toBe(404);
  });

  it("refuses a superseded link once a reset link is issued", async () => {
    const { test, cookie } = await ownerApp();
    const invited = await invite(test, cookie);

    const response = await send(test.app, "POST", `/api/users/${invited.user.id}/reset-link`, {
      cookie,
    });
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const reset = InviteUserResponseSchema.parse(await response.json());
    expect(reset.user.id).toBe(invited.user.id);
    expect(reset.expiresAt).toBe(
      new Date(test.clock.now().getTime() + PASSWORD_TOKEN_TTL_MS.reset).toISOString(),
    );
    const resetToken = tokenFrom(reset.setPasswordUrl);

    expect((await inspect(test, invited.token)).status).toBe(404);
    expect((await setPassword(test, invited.token, testPassword("old"))).status).toBe(404);

    const info = PasswordTokenInfoSchema.parse(await (await inspect(test, resetToken)).json());
    expect(info.purpose).toBe("reset");
    expect((await setPassword(test, resetToken, testPassword("new"))).status).toBe(204);
  });

  it("refuses unknown and malformed tokens", async () => {
    const { test } = await ownerApp();
    const unknown = await inspect(test, unknownToken());
    expect(unknown.status).toBe(404);

    const malformed = await inspect(test, "short");
    expect(malformed.status).toBe(400);
    expect(await errorCode(malformed)).toBe("validation_failed");

    // Shorter than the minimum length, generated at runtime.
    const weak = await setPassword(test, unknownToken(), testPassword("w").slice(0, 4));
    expect(weak.status).toBe(400);
  });

  it("ends every session of the account when a reset link is used", async () => {
    const { test, cookie } = await ownerApp();
    const member = await insertUser(testDb.db, { role: "admin" });
    const { cookie: memberCookie } = await login(test.app, member.email, undefined, nextIp());
    expect((await send(test.app, "GET", "/api/auth/me", { cookie: memberCookie })).status).toBe(
      200,
    );

    const response = await send(test.app, "POST", `/api/users/${member.id}/reset-link`, {
      cookie,
    });
    const reset = InviteUserResponseSchema.parse(await response.json());
    const chosen = testPassword("reset");
    expect((await setPassword(test, tokenFrom(reset.setPasswordUrl), chosen)).status).toBe(204);

    expect((await send(test.app, "GET", "/api/auth/me", { cookie: memberCookie })).status).toBe(
      401,
    );
    expect(
      await testDb.db.select().from(sessions).where(eq(sessions.userId, member.id)),
    ).toHaveLength(0);
    const audit = await testDb.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.targetId, member.id), eq(auditLog.action, "auth.password.set")));
    expect(audit[0]?.data).toMatchObject({ purpose: "reset", sessionsEnded: 1 });
    await login(test.app, member.email, chosen, nextIp());
  });

  it("refuses an owner role and a taken email", async () => {
    const { test, cookie } = await ownerApp();
    const owner = await send(test.app, "POST", "/api/users/invitations", {
      cookie,
      body: { email: uniqueEmail("second-owner"), name: "Owner Two", role: "owner" },
    });
    expect(owner.status).toBe(400);
    expect(await errorCode(owner)).toBe("validation_failed");

    const invited = await invite(test, cookie);
    const taken = await send(test.app, "POST", "/api/users/invitations", {
      cookie,
      body: { email: invited.user.email.toUpperCase(), name: "Again", role: "admin" },
    });
    expect(taken.status).toBe(409);
    expect(await errorCode(taken)).toBe("conflict");
  });
});

describe("owner-only user routes", () => {
  it("lets only the owner list, invite, reset and disable", async () => {
    const { test, ownerId, cookie } = await ownerApp();
    const member = await insertUser(testDb.db, { role: "admin" });
    const { cookie: adminCookie } = await login(test.app, member.email, undefined, nextIp());

    const list = await send(test.app, "GET", "/api/users", { cookie });
    expect(list.status).toBe(200);
    const body = (await list.json()) as { items: unknown[] };
    const items = body.items.map((item) => UserSummarySchema.parse(item));
    expect(items.map((item) => item.id)).toEqual([ownerId, member.id]);

    const attempts: [string, string, unknown][] = [
      ["GET", "/api/users", undefined],
      ["POST", "/api/users/invitations", { email: uniqueEmail("x"), name: "X", role: "admin" }],
      ["POST", `/api/users/${ownerId}/reset-link`, undefined],
      ["POST", `/api/users/${ownerId}/disable`, undefined],
    ];
    for (const [method, path, requestBody] of attempts) {
      const asAdmin = await send(test.app, method, path, {
        cookie: adminCookie,
        body: requestBody,
      });
      expect(asAdmin.status, `${method} ${path}`).toBe(403);
      const anonymous = await send(test.app, method, path, { body: requestBody });
      expect(anonymous.status, `${method} ${path}`).toBe(401);
    }
    expect(await testDb.db.select().from(users)).toHaveLength(2);
    expect(await testDb.db.select().from(passwordTokens)).toHaveLength(0);
  });

  it("answers 404 for unknown users", async () => {
    const { test, cookie } = await ownerApp();
    for (const action of ["reset-link", "disable"]) {
      const response = await send(test.app, "POST", `/api/users/${randomUUID()}/${action}`, {
        cookie,
      });
      expect(response.status).toBe(404);
    }
  });
});

describe("disable", () => {
  it("disables the account and ends its sessions, tokens and links", async () => {
    const { test, ownerId, cookie } = await ownerApp();
    const member = await insertUser(testDb.db, { role: "admin" });
    const { cookie: memberCookie } = await login(test.app, member.email, undefined, nextIp());
    const mcp = await test.app.request("/api/tokens", {
      method: "POST",
      headers: {
        Cookie: memberCookie,
        Origin: APP_ORIGIN,
        "Content-Type": "application/json",
        "X-Forwarded-For": nextIp(),
      },
      body: JSON.stringify({ name: "Laptop", scopes: ["mcp:read"] }),
    });
    expect(mcp.status).toBe(201);
    const { secret } = (await mcp.json()) as { secret: string };
    const [project] = await testDb.db
      .insert(projects)
      .values({ slug: `p-${randomUUID()}`, name: "P", createdBy: member.id })
      .returning();
    const [job] = await testDb.db
      .insert(jobs)
      .values({
        type: "system.ping",
        payload: {},
        projectId: project?.id ?? "",
        createdBy: member.id,
      })
      .returning();
    const deps = { db: testDb.db, clock: test.clock };
    const minted = await createTokensService(deps).mintJobToken({
      jobId: job?.id ?? "",
      projectId: project?.id ?? "",
      userId: member.id,
      access: "read",
      ttlMs: 60_000,
    });
    const resetResponse = await send(test.app, "POST", `/api/users/${member.id}/reset-link`, {
      cookie,
    });
    const reset = InviteUserResponseSchema.parse(await resetResponse.json());

    const response = await send(test.app, "POST", `/api/users/${member.id}/disable`, { cookie });
    expect(response.status).toBe(200);
    const summary = UserSummarySchema.parse(await response.json());
    expect(summary).toMatchObject({
      id: member.id,
      disabledAt: test.clock.now().toISOString(),
    });

    expect((await send(test.app, "GET", "/api/auth/me", { cookie: memberCookie })).status).toBe(
      401,
    );
    const tokenRows = await testDb.db
      .select()
      .from(apiTokens)
      .where(eq(apiTokens.userId, member.id));
    expect(tokenRows).toHaveLength(2);
    for (const row of tokenRows) {
      expect(row.revokedAt).not.toBeNull();
    }
    const tokens = createTokensService(deps);
    expect(await tokens.verify(secret, "mcp")).toBeNull();
    expect(await tokens.verify(minted.secret, "job")).toBeNull();
    expect((await inspect(test, tokenFrom(reset.setPasswordUrl))).status).toBe(404);
    const audit = await testDb.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.targetId, member.id), eq(auditLog.action, "user.disabled")));
    expect(audit).toMatchObject([
      {
        actorId: ownerId,
        data: { sessionsEnded: 1, tokensRevoked: 2, linksVoided: 1 },
      },
    ]);

    // Disabling again changes nothing.
    const again = await send(test.app, "POST", `/api/users/${member.id}/disable`, { cookie });
    expect(again.status).toBe(200);
    expect(UserSummarySchema.parse(await again.json()).disabledAt).toBe(summary.disabledAt);

    // A disabled account gets no new link.
    const refused = await send(test.app, "POST", `/api/users/${member.id}/reset-link`, {
      cookie,
    });
    expect(refused.status).toBe(409);
  });

  it("refuses to disable the signed-in owner", async () => {
    const { test, ownerId, cookie } = await ownerApp();
    const response = await send(test.app, "POST", `/api/users/${ownerId}/disable`, { cookie });
    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe("conflict");
    const [owner] = await testDb.db.select().from(users).where(eq(users.id, ownerId));
    expect(owner?.disabledAt).toBeNull();
  });

  it("refuses a link whose account was disabled after it was issued", async () => {
    const { test, cookie } = await ownerApp();
    const invited = await invite(test, cookie);
    await send(test.app, "POST", `/api/users/${invited.user.id}/disable`, { cookie });
    expect((await setPassword(test, invited.token, testPassword("late"))).status).toBe(404);
  });
});

describe("public set-password routes", () => {
  it("apply the Origin check", async () => {
    const { test, cookie } = await ownerApp();
    const invited = await invite(test, cookie);
    const crossSite = await setPassword(test, invited.token, testPassword("x"), {
      origin: "https://evil.example.test",
    });
    expect(crossSite.status).toBe(403);
    const noOrigin = await setPassword(test, invited.token, testPassword("x"), { origin: null });
    expect(noOrigin.status).toBe(403);
    expect((await inspect(test, invited.token)).status).toBe(200);
  });

  it("are rate-limited per client address", async () => {
    const { test } = await ownerApp();
    const address = nextIp();
    for (let i = 0; i < PASSWORD_LINK_LIMIT.capacity; i += 1) {
      const response =
        i % 2 === 0
          ? await inspect(test, unknownToken(), { ip: address })
          : await setPassword(test, unknownToken(), testPassword("x"), { ip: address });
      expect(response.status).toBe(404);
    }
    const limited = await inspect(test, unknownToken(), { ip: address });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).not.toBeNull();
    const setLimited = await setPassword(test, unknownToken(), testPassword("x"), { ip: address });
    expect(setLimited.status).toBe(429);
    // Another address is unaffected.
    expect((await inspect(test, unknownToken())).status).toBe(404);
  });
});
