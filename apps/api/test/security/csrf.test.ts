import { buildPath, type PathParams, type RouteName, routes } from "@loomcast/contracts";
import { createTestDb, type TestDb } from "@loomcast/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, insertUser, login, send, testIp } from "../support";

/**
 * Every unsafe cookie route of the contracts refuses a cross-site request before its handler runs:
 * a foreign `Origin`, a cross-site `Sec-Fetch-Site` without `Origin`, and a body that is not JSON
 * (what a plain HTML form can send). The machine API (`auth: "api_key"`) is no browser surface: it
 * never reads the cookie, so a cross-site request that carries one is simply unauthenticated.
 */

const SAMPLE_ID = "00000000-0000-4000-8000-000000000000";
const FOREIGN = "https://evil.example";
const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

let testDb: TestDb;

beforeAll(async () => {
  testDb = await createTestDb();
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

const unsafeRoutes = (Object.keys(routes) as RouteName[]).filter(
  (name) => UNSAFE.has(routes[name].method) && routes[name].auth !== "api_key",
);

const machineRoutes = (Object.keys(routes) as RouteName[]).filter(
  (name) => routes[name].auth === "api_key",
);

async function reason(response: Response): Promise<unknown> {
  const body = (await response.json()) as { error?: { code?: string; details?: unknown } };
  expect(body.error?.code).toBe("forbidden");
  return (body.error?.details as { reason?: unknown } | undefined)?.reason;
}

describe("csrf on every unsafe route", () => {
  it("covers the unsafe routes of the contracts", () => {
    expect(unsafeRoutes.length).toBeGreaterThan(40);
  });

  it("refuses a foreign Origin, even with a valid session", async () => {
    const { app } = createTestApp(testDb.db);
    const user = await insertUser(testDb.db, { role: "owner" });
    const { cookie } = await login(app, user.email, undefined, testIp(1));
    for (const name of unsafeRoutes) {
      const route = routes[name];
      const response = await send(app, route.method, samplePath(route.path), {
        cookie,
        body: {},
        origin: FOREIGN,
        ip: testIp(2),
      });
      expect(response.status, name).toBe(403);
      expect(await reason(response), name).toBe("origin");
    }
  });

  it("refuses a cross-site request without Origin on every route but pairing", async () => {
    const { app } = createTestApp(testDb.db);
    const user = await insertUser(testDb.db, { role: "owner" });
    const { cookie } = await login(app, user.email, undefined, testIp(3));
    for (const name of unsafeRoutes) {
      // The studio agent pairs without Origin; a browser always sends Origin on a POST.
      if (name === "bridge.pair") {
        continue;
      }
      const route = routes[name];
      const response = await send(app, route.method, samplePath(route.path), {
        cookie,
        body: {},
        origin: null,
        headers: { "Sec-Fetch-Site": "cross-site" },
        ip: testIp(4),
      });
      expect(response.status, name).toBe(403);
      expect(await reason(response), name).toBe("origin");
    }
  });

  it("refuses bodies a form can send, from the app's own origin", async () => {
    const { app } = createTestApp(testDb.db);
    const user = await insertUser(testDb.db, { role: "owner" });
    const { cookie } = await login(app, user.email, undefined, testIp(5));
    for (const name of unsafeRoutes) {
      const route = routes[name];
      for (const contentType of [
        "text/plain",
        "application/x-www-form-urlencoded",
        "multipart/form-data; boundary=x",
      ]) {
        const response = await send(app, route.method, samplePath(route.path), {
          cookie,
          body: "{}",
          contentType,
          origin: name === "bridge.pair" ? null : undefined,
          ip: testIp(6),
        });
        expect(response.status, `${name} ${contentType}`).toBe(403);
        expect(await reason(response), `${name} ${contentType}`).toBe("content_type");
      }
    }
  });

  it("answers 401 on the machine API to a cross-site request with a session cookie", async () => {
    const { app } = createTestApp(testDb.db);
    const user = await insertUser(testDb.db, { role: "owner" });
    const { cookie } = await login(app, user.email, undefined, testIp(7));
    expect(machineRoutes.length).toBeGreaterThan(5);
    for (const name of machineRoutes) {
      const route = routes[name];
      const response = await send(app, route.method, samplePath(route.path), {
        cookie,
        body: UNSAFE.has(route.method) ? {} : undefined,
        origin: FOREIGN,
        ip: testIp(8),
      });
      expect(response.status, name).toBe(401);
    }
  });

  it("refuses a foreign Origin on /mcp", async () => {
    const { app } = createTestApp(testDb.db);
    const response = await send(app, "POST", "/mcp", { body: {}, origin: FOREIGN });
    expect(response.status).toBe(403);
  });
});
