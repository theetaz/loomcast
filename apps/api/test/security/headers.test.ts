import { createTestDb, type TestDb } from "@loomcast/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, insertUser, PASSWORD, send } from "../support";

/**
 * Security headers per route class. The policies are asserted as exact strings, so loosening one
 * (a new source, a dropped directive) fails here and has to be reviewed on purpose.
 */

const MEDIA = "https://media.example.test";

const WEB_CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data: blob: ${MEDIA}`,
  `media-src 'self' blob: ${MEDIA}`,
  "font-src 'self' data:",
  `connect-src 'self' ${MEDIA}`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const SERVER_CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

/** Headers every response carries, whatever its route class. */
const COMMON_HEADERS = {
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
} as const;

let testDb: TestDb;

beforeAll(async () => {
  testDb = await createTestDb();
});

afterAll(async () => {
  await testDb.drop();
});

function expectCommonHeaders(response: Response, label: string): void {
  for (const [name, value] of Object.entries(COMMON_HEADERS)) {
    expect(response.headers.get(name), `${label}: ${name}`).toBe(value);
  }
  expect(response.headers.get("x-powered-by"), label).toBeNull();
}

describe("security headers per route class", () => {
  const cases: ReadonlyArray<{ label: string; method: string; path: string; csp: string }> = [
    { label: "web app document", method: "GET", path: "/", csp: WEB_CSP },
    { label: "web app client route", method: "GET", path: "/workspaces/abc", csp: WEB_CSP },
    { label: "web app file", method: "GET", path: "/assets/index.js", csp: WEB_CSP },
    { label: "session api", method: "GET", path: "/api/auth/me", csp: SERVER_CSP },
    { label: "public api", method: "POST", path: "/api/auth/login", csp: SERVER_CSP },
    { label: "unknown api path", method: "GET", path: "/api/nope", csp: SERVER_CSP },
    { label: "mcp", method: "POST", path: "/mcp", csp: SERVER_CSP },
    { label: "bridge without upgrade", method: "GET", path: "/bridge/v1", csp: SERVER_CSP },
    { label: "liveness probe", method: "GET", path: "/healthz", csp: SERVER_CSP },
    { label: "readiness probe", method: "GET", path: "/readyz", csp: SERVER_CSP },
  ];

  for (const { label, method, path, csp } of cases) {
    it(`sets the exact policy and headers on ${label} (${method} ${path})`, async () => {
      const { app } = createTestApp(testDb.db, { config: { storage: null } });
      const response = await send(app, method, path, {
        body: method === "GET" ? undefined : {},
      });
      expect(response.headers.get("content-security-policy"), label).toBe(csp);
      expectCommonHeaders(response, label);
    });
  }

  it("sets the headers on error responses too", async () => {
    const { app } = createTestApp(testDb.db, { config: { storage: null } });
    const response = await send(app, "POST", "/api/auth/login", {
      body: "{not json",
    });
    expect(response.status).toBe(400);
    expect(response.headers.get("content-security-policy")).toBe(SERVER_CSP);
    expectCommonHeaders(response, "400");
  });

  it("never allows inline or evaluated script in the web app's policy", async () => {
    const { app } = createTestApp(testDb.db);
    const csp = (await app.request("/")).headers.get("content-security-policy") ?? "";
    const scriptSrc = csp.split(";").find((part) => part.trim().startsWith("script-src")) ?? "";
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(scriptSrc).not.toContain("'unsafe-eval'");
    expect(csp).not.toMatch(/(^|\s)\*(\s|;|$)/);
  });
});

describe("production cookie flags", () => {
  const APP = "https://app.example.test";

  it("issues a __Host- session cookie: Secure, HttpOnly, SameSite=Lax, Path=/, no Domain", async () => {
    const { app } = createTestApp(testDb.db, {
      config: { nodeEnv: "production", isProduction: true, appOrigin: APP },
    });
    const user = await insertUser(testDb.db);
    const response = await send(app, "POST", "/api/auth/login", {
      body: { email: user.email, password: PASSWORD },
      origin: APP,
    });
    expect(response.status).toBe(200);
    const cookies = response.headers.getSetCookie();
    expect(cookies).toHaveLength(1);
    const attributes = (cookies[0] ?? "").split(";").map((part) => part.trim());
    expect(attributes[0]).toMatch(/^__Host-lc_session=[A-Za-z0-9_-]{43}$/);
    const flags = attributes.slice(1).map((part) => part.split("=")[0]?.toLowerCase());
    expect(flags).toEqual(expect.arrayContaining(["path", "httponly", "secure", "samesite"]));
    expect(flags).not.toContain("domain");
    expect(attributes).toContain("Path=/");
    expect(attributes).toContain("SameSite=Lax");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("clears the cookie with the same flags on logout", async () => {
    const { app } = createTestApp(testDb.db, {
      config: { nodeEnv: "production", isProduction: true, appOrigin: APP },
    });
    const user = await insertUser(testDb.db);
    const login = await send(app, "POST", "/api/auth/login", {
      body: { email: user.email, password: PASSWORD },
      origin: APP,
    });
    const cookie = (login.headers.getSetCookie()[0] ?? "").split(";")[0] ?? "";
    const logout = await send(app, "POST", "/api/auth/logout", { cookie, origin: APP });
    expect(logout.status).toBe(204);
    const cleared = logout.headers.getSetCookie()[0] ?? "";
    expect(cleared).toMatch(/^__Host-lc_session=;/);
    expect(cleared).toContain("Max-Age=0");
    expect(cleared).toContain("Secure");
    expect(cleared).toContain("Path=/");
  });
});
