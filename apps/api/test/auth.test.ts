import { MeSchema } from "@loomcast/contracts";
import { auditLog, sessions, users } from "@loomcast/db";
import { createTestDb, type TestDb } from "@loomcast/db/testing";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SESSION_RENEW_INTERVAL_MS, SESSION_TTL_MS } from "../src/modules/auth/sessions";
import {
  APP_ORIGIN,
  createTestApp,
  errorCode,
  insertUser,
  login,
  PASSWORD,
  send,
  sessionCookie,
  testIp,
  testPassword,
} from "./support";

const DAY_MS = 24 * 60 * 60 * 1000;

let testDb: TestDb;

beforeAll(async () => {
  testDb = await createTestDb();
});

afterAll(async () => {
  await testDb.drop();
});

describe("login", () => {
  it("signs in with the right password and sets the session cookie", async () => {
    const { app, clock } = createTestApp(testDb.db);
    const user = await insertUser(testDb.db, { email: "login-ok@example.test" });

    const response = await send(app, "POST", "/api/auth/login", {
      body: { email: "  LOGIN-OK@example.test ", password: PASSWORD },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const me = MeSchema.parse(await response.json());
    expect(me).toMatchObject({ id: user.id, email: user.email, role: "admin" });
    expect(me.lastLoginAt).toBe(clock.now().toISOString());

    const cookie = sessionCookie(response);
    expect(cookie).toMatch(/^lc_session=[A-Za-z0-9_-]{43}$/);
    const stored = await testDb.db.select().from(sessions).where(eq(sessions.userId, user.id));
    expect(stored).toHaveLength(1);
    // Only the hash is stored.
    expect(stored[0]?.id).not.toBe(cookie?.split("=")[1]);
    expect(stored[0]?.id).toMatch(/^[0-9a-f]{64}$/);

    const audits = await testDb.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.actorId, user.id), eq(auditLog.action, "auth.login.succeeded")));
    expect(audits).toHaveLength(1);
  });

  it("rejects a wrong password, an unknown email and a disabled account the same way", async () => {
    const { app } = createTestApp(testDb.db);
    const active = await insertUser(testDb.db);
    const disabled = await insertUser(testDb.db, { disabledAt: new Date() });

    const attempts = [
      { email: active.email, password: testPassword("wrong") },
      { email: "nobody@example.test", password: PASSWORD },
      { email: disabled.email, password: PASSWORD },
    ];
    const bodies: unknown[] = [];
    for (const [index, body] of attempts.entries()) {
      const response = await send(app, "POST", "/api/auth/login", {
        body,
        ip: `198.51.100.${index + 1}`,
      });
      expect(response.status).toBe(401);
      expect(sessionCookie(response)).toBeNull();
      bodies.push(await response.json());
    }
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[2]).toEqual(bodies[0]);

    const failures = await testDb.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "auth.login.failed"));
    const reasons = failures.map((row) => row.data?.reason);
    expect(reasons).toEqual(
      expect.arrayContaining(["wrong_password", "unknown_email", "disabled"]),
    );
  });

  it("validates the body", async () => {
    const { app } = createTestApp(testDb.db);
    const invalid = await send(app, "POST", "/api/auth/login", { body: { email: "not-an-email" } });
    expect(invalid.status).toBe(400);
    expect(await errorCode(invalid)).toBe("validation_failed");

    const malformed = await send(app, "POST", "/api/auth/login", { body: "{oops" });
    expect(malformed.status).toBe(400);
    expect(await errorCode(malformed)).toBe("bad_request");
  });
});

describe("login rate limits", () => {
  it("locks an address and email out after 5 attempts a minute", async () => {
    const { app, clock } = createTestApp(testDb.db);
    const user = await insertUser(testDb.db);
    const attempt = (password: string, ip = "192.0.2.1") =>
      send(app, "POST", "/api/auth/login", { body: { email: user.email, password }, ip });

    for (let index = 0; index < 5; index += 1) {
      expect((await attempt(testPassword("wrong"))).status).toBe(401);
    }
    const locked = await attempt(PASSWORD);
    expect(locked.status).toBe(429);
    expect(await errorCode(locked)).toBe("rate_limited");
    expect(Number(locked.headers.get("retry-after"))).toBeGreaterThan(0);

    // Another address still gets its own five attempts.
    expect((await attempt(PASSWORD, "192.0.2.2")).status).toBe(200);

    // One token returns every 12 seconds.
    clock.advance(12_000);
    expect((await attempt(PASSWORD)).status).toBe(200);
    expect((await attempt(PASSWORD)).status).toBe(429);
  });

  it("limits one address to 20 attempts a minute across emails", async () => {
    const { app } = createTestApp(testDb.db);
    for (let index = 0; index < 20; index += 1) {
      const response = await send(app, "POST", "/api/auth/login", {
        body: { email: `spray-${index}@example.test`, password: testPassword("spray") },
        ip: "192.0.2.50",
      });
      expect(response.status).toBe(401);
    }
    const blocked = await send(app, "POST", "/api/auth/login", {
      body: { email: "spray-final@example.test", password: testPassword("spray") },
      ip: "192.0.2.50",
    });
    expect(blocked.status).toBe(429);
  });
});

describe("csrf guard", () => {
  it("rejects a foreign Origin", async () => {
    const { app } = createTestApp(testDb.db);
    const user = await insertUser(testDb.db);
    const response = await send(app, "POST", "/api/auth/login", {
      body: { email: user.email, password: PASSWORD },
      origin: "https://evil.example",
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { code: "forbidden", details: { reason: "origin" } },
    });
  });

  it("rejects a form content type", async () => {
    const { app } = createTestApp(testDb.db);
    const user = await insertUser(testDb.db);
    const response = await send(app, "POST", "/api/auth/login", {
      body: `email=${encodeURIComponent(user.email)}&password=x`,
      contentType: "application/x-www-form-urlencoded",
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { details: { reason: "content_type" } } });

    const plain = await send(app, "POST", "/api/auth/login", {
      body: JSON.stringify({ email: user.email, password: PASSWORD }),
      contentType: "text/plain",
    });
    expect(plain.status).toBe(403);
  });

  it("accepts Sec-Fetch-Site same-origin without Origin and rejects cross-site", async () => {
    const { app } = createTestApp(testDb.db);
    const user = await insertUser(testDb.db);
    const body = { email: user.email, password: PASSWORD };

    const sameOrigin = await send(app, "POST", "/api/auth/login", {
      body,
      origin: null,
      headers: { "Sec-Fetch-Site": "same-origin" },
    });
    expect(sameOrigin.status).toBe(200);

    const crossSite = await send(app, "POST", "/api/auth/login", {
      body,
      origin: null,
      headers: { "Sec-Fetch-Site": "cross-site" },
    });
    expect(crossSite.status).toBe(403);

    const neither = await send(app, "POST", "/api/auth/login", { body, origin: null });
    expect(neither.status).toBe(403);
  });

  it("guards session routes too, before the session is checked", async () => {
    const { app } = createTestApp(testDb.db);
    const user = await insertUser(testDb.db);
    const { cookie } = await login(app, user.email);

    const foreign = await send(app, "POST", "/api/auth/logout", {
      cookie,
      origin: "https://evil.example",
    });
    expect(foreign.status).toBe(403);
    const form = await send(app, "POST", "/api/auth/logout", {
      cookie,
      contentType: "multipart/form-data; boundary=x",
    });
    expect(form.status).toBe(403);

    // The session survived both attempts.
    expect((await send(app, "GET", "/api/auth/me", { cookie })).status).toBe(200);
    // Safe methods need no Origin.
    expect((await send(app, "GET", "/api/auth/me", { cookie, origin: null })).status).toBe(200);
  });
});

describe("sessions", () => {
  it("returns the signed-in user and logs out", async () => {
    const { app } = createTestApp(testDb.db);
    const user = await insertUser(testDb.db);
    const { cookie } = await login(app, user.email);

    const me = await send(app, "GET", "/api/auth/me", { cookie });
    expect(me.status).toBe(200);
    expect(MeSchema.parse(await me.json()).id).toBe(user.id);

    const logout = await send(app, "POST", "/api/auth/logout", { cookie });
    expect(logout.status).toBe(204);
    const cleared = logout.headers.getSetCookie().join("\n");
    expect(cleared).toMatch(/lc_session=;/);
    expect(cleared).toMatch(/Max-Age=0/);

    const after = await send(app, "GET", "/api/auth/me", { cookie });
    expect(after.status).toBe(401);
    const left = await testDb.db.select().from(sessions).where(eq(sessions.userId, user.id));
    expect(left).toHaveLength(0);
  });

  it("rejects requests without a cookie or with an unknown one", async () => {
    const { app } = createTestApp(testDb.db);
    expect((await send(app, "GET", "/api/auth/me")).status).toBe(401);
    const unknown = await send(app, "GET", "/api/auth/me", {
      cookie: `lc_session=${"A".repeat(43)}`,
    });
    expect(unknown.status).toBe(401);
    expect(await errorCode(unknown)).toBe("unauthorized");
  });

  it("expires a session after 30 days without activity", async () => {
    const { app, clock } = createTestApp(testDb.db);
    const user = await insertUser(testDb.db);
    const { cookie } = await login(app, user.email);

    clock.advance(SESSION_TTL_MS + 1);
    const expired = await send(app, "GET", "/api/auth/me", { cookie });
    expect(expired.status).toBe(401);
    expect(expired.headers.getSetCookie().join("\n")).toMatch(/lc_session=;/);
    const left = await testDb.db.select().from(sessions).where(eq(sessions.userId, user.id));
    expect(left).toHaveLength(0);
  });

  it("slides the expiry forward with activity", async () => {
    const { app, clock } = createTestApp(testDb.db);
    const user = await insertUser(testDb.db);
    const { cookie } = await login(app, user.email);
    const [before] = await testDb.db.select().from(sessions).where(eq(sessions.userId, user.id));

    // Within the renewal interval nothing is written and no cookie is re-issued.
    clock.advance(SESSION_RENEW_INTERVAL_MS - 1);
    const quiet = await send(app, "GET", "/api/auth/me", { cookie });
    expect(quiet.status).toBe(200);
    expect(sessionCookie(quiet)).toBeNull();

    clock.advance(20 * DAY_MS);
    const renewed = await send(app, "GET", "/api/auth/me", { cookie });
    expect(renewed.status).toBe(200);
    const reissued = renewed.headers.getSetCookie().join("\n");
    expect(sessionCookie(renewed)).toBe(cookie);
    expect(reissued).toMatch(`Max-Age=${SESSION_TTL_MS / 1000}`);

    const [after] = await testDb.db.select().from(sessions).where(eq(sessions.userId, user.id));
    expect(after?.expiresAt.getTime()).toBe(clock.now().getTime() + SESSION_TTL_MS);
    expect(after?.expiresAt.getTime()).toBeGreaterThan(before?.expiresAt.getTime() ?? 0);

    // 40 days after login: past the original expiry, but still inside the renewed one.
    clock.advance(20 * DAY_MS);
    expect((await send(app, "GET", "/api/auth/me", { cookie })).status).toBe(200);
  });

  it("ends sessions of a disabled account", async () => {
    const { app } = createTestApp(testDb.db);
    const user = await insertUser(testDb.db);
    const { cookie } = await login(app, user.email);
    await testDb.db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, user.id));
    expect((await send(app, "GET", "/api/auth/me", { cookie })).status).toBe(401);
  });
});

describe("password change", () => {
  it("requires the current password", async () => {
    const { app } = createTestApp(testDb.db);
    const user = await insertUser(testDb.db);
    const { cookie } = await login(app, user.email);
    const response = await send(app, "POST", "/api/auth/password", {
      cookie,
      body: { currentPassword: testPassword("wrong"), newPassword: testPassword("new") },
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "validation_failed", details: [{ path: "currentPassword" }] },
    });
  });

  it("rejects a short new password", async () => {
    const { app } = createTestApp(testDb.db);
    const user = await insertUser(testDb.db);
    const { cookie } = await login(app, user.email);
    const response = await send(app, "POST", "/api/auth/password", {
      cookie,
      body: { currentPassword: PASSWORD, newPassword: "short" },
    });
    expect(response.status).toBe(400);
  });

  it("changes the password and revokes every other session", async () => {
    const { app } = createTestApp(testDb.db);
    const user = await insertUser(testDb.db);
    const first = await login(app, user.email, PASSWORD, testIp(101));
    const second = await login(app, user.email, PASSWORD, testIp(102));
    const newPassword = testPassword("new");

    const response = await send(app, "POST", "/api/auth/password", {
      cookie: first.cookie,
      body: { currentPassword: PASSWORD, newPassword },
    });
    expect(response.status).toBe(204);

    expect((await send(app, "GET", "/api/auth/me", { cookie: first.cookie })).status).toBe(200);
    expect((await send(app, "GET", "/api/auth/me", { cookie: second.cookie })).status).toBe(401);

    const old = await send(app, "POST", "/api/auth/login", {
      body: { email: user.email, password: PASSWORD },
      ip: "192.0.2.103",
    });
    expect(old.status).toBe(401);
    await login(app, user.email, newPassword, testIp(104));
  });
});

describe("production cookies", () => {
  it("uses the __Host- prefix with Secure, HttpOnly, SameSite=Lax and Path=/", async () => {
    const { app } = createTestApp(testDb.db, {
      config: { nodeEnv: "production", isProduction: true, appOrigin: "https://app.example.test" },
    });
    const user = await insertUser(testDb.db);
    const response = await send(app, "POST", "/api/auth/login", {
      body: { email: user.email, password: PASSWORD },
      origin: "https://app.example.test",
    });
    expect(response.status).toBe(200);

    const [header] = response.headers.getSetCookie();
    expect(header).toBeDefined();
    const attributes = (header ?? "").split(";").map((part) => part.trim());
    expect(attributes[0]).toMatch(/^__Host-lc_session=[A-Za-z0-9_-]{43}$/);
    expect(attributes).toEqual(
      expect.arrayContaining([
        `Max-Age=${SESSION_TTL_MS / 1000}`,
        "Path=/",
        "HttpOnly",
        "Secure",
        "SameSite=Lax",
      ]),
    );
    expect(attributes.some((part) => part.toLowerCase().startsWith("domain="))).toBe(false);

    const cookie = attributes[0] ?? "";
    const me = await send(app, "GET", "/api/auth/me", { cookie });
    expect(me.status).toBe(200);
    // The development cookie name is not accepted in production.
    const devName = await send(app, "GET", "/api/auth/me", {
      cookie: cookie.replace("__Host-", ""),
    });
    expect(devName.status).toBe(401);
  });

  it("keeps the development cookie without Secure", async () => {
    const { app } = createTestApp(testDb.db);
    const user = await insertUser(testDb.db);
    const { response } = await login(app, user.email);
    const header = response.headers.getSetCookie()[0] ?? "";
    expect(header).toMatch(/^lc_session=/);
    expect(header).toMatch(/HttpOnly/);
    expect(header).toMatch(/SameSite=Lax/);
    expect(header).not.toMatch(/Secure/);
    expect(APP_ORIGIN).toBe("http://localhost:5173");
  });
});
