import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPath, type PathParams, routes } from "@loomcast/contracts";
import { createTestDb, type TestDb } from "@loomcast/db/testing";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isPublicApiRoute } from "../src/app";
import type { AppDeps } from "../src/deps";
import { createEventBus } from "../src/lib/bus";
import { createLifecycle } from "../src/lib/lifecycle";
import { createLogger } from "../src/lib/logger";
import { createTokensService } from "../src/modules/tokens/service";
import { startServer } from "../src/server";
import type { AppEnv } from "../src/types";
import {
  createTestApp,
  createTestClock,
  errorCode,
  insertUser,
  login,
  PASSWORD,
  send,
  testConfig,
  testPassword,
} from "./support";

const SAMPLE_ID = "00000000-0000-4000-8000-000000000000";

let testDb: TestDb;

beforeAll(async () => {
  testDb = await createTestDb();
});

afterAll(async () => {
  await testDb.drop();
});

describe("health checks", () => {
  it("answers healthz and readyz without a session", async () => {
    const { app } = createTestApp(testDb.db);
    const health = await app.request("/healthz");
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok" });

    const ready = await app.request("/readyz");
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ status: "ok", checks: { database: "ok" } });
  });

  it("reports not ready once shutdown starts", async () => {
    const { app, deps } = createTestApp(testDb.db);
    await deps.lifecycle.close();
    const ready = await app.request("/readyz");
    expect(ready.status).toBe(503);
  });

  it("reports not ready when the database is unreachable", async () => {
    const broken = await createTestDb({ empty: true });
    const { app } = createTestApp(broken.db);
    await broken.drop();
    const ready = await app.request("/readyz");
    expect(ready.status).toBe(503);
    expect(await ready.json()).toMatchObject({ checks: { database: "error" } });
  });
});

describe("default deny", () => {
  it("allows only login, pairing and set-password among the API routes without a session", () => {
    const publicRoutes = Object.entries(routes)
      .filter(([, route]) => isPublicApiRoute(route.method, route.path))
      .map(([name]) => name);
    expect(publicRoutes.sort()).toEqual([
      "auth.inspectPasswordToken",
      "auth.login",
      "auth.setPassword",
      "bridge.pair",
    ]);
  });

  it("answers 401 for every session route of the contracts without a cookie", async () => {
    const { app } = createTestApp(testDb.db);
    for (const [name, route] of Object.entries(routes)) {
      if (route.auth !== "session") {
        continue;
      }
      const params = Object.fromEntries(
        [...route.path.matchAll(/:([A-Za-z]+)/g)].map((match) => [match[1], SAMPLE_ID]),
      ) as PathParams<string>;
      const response = await send(app, route.method, buildPath(route.path, params), {
        body: route.method === "GET" || route.method === "DELETE" ? undefined : {},
      });
      expect(response.status, name).toBe(401);
      expect(await errorCode(response), name).toBe("unauthorized");
    }
  });

  it("answers 401, not 404, for unknown API paths", async () => {
    const { app } = createTestApp(testDb.db);
    expect((await send(app, "GET", "/api/nope")).status).toBe(401);
    expect((await send(app, "POST", "/api/auth/login/extra", { body: {} })).status).toBe(401);
  });

  it("lets the public pairing route through to its module", async () => {
    const { app } = createTestApp(testDb.db);
    // The request passes the guard and reaches the pairing handler, which validates the body.
    const response = await send(app, "POST", "/api/bridge/pair", { origin: null, body: {} });
    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe("validation_failed");
  });

  it("answers 404 with an ApiError body outside the API", async () => {
    const { app } = createTestApp(testDb.db);
    for (const path of ["/", "/bridge/v1", "/projects/abc"]) {
      const response = await app.request(path);
      expect(response.status, path).toBe(404);
      expect(await response.json()).toEqual({
        error: { code: "not_found", message: "Not found." },
      });
    }
  });
});

describe("middleware", () => {
  it("sets security headers and a request id", async () => {
    const { app } = createTestApp(testDb.db);
    const response = await app.request("/healthz");
    expect(response.headers.get("x-request-id")).toMatch(/.+/);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    const csp = response.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it("rejects bodies over 1 MiB", async () => {
    const { app } = createTestApp(testDb.db);
    const response = await send(app, "POST", "/api/auth/login", {
      body: JSON.stringify({ email: "a@example.test", password: "x".repeat(1024 * 1024) }),
    });
    expect(response.status).toBe(413);
    expect(await errorCode(response)).toBe("payload_too_large");
  });

  it("turns unexpected errors into a 500 without details", async () => {
    const { app, logs } = createTestApp(testDb.db, {
      modules: [
        (parent) => {
          const router = new Hono<AppEnv>();
          router.get("/boom", () => {
            throw new Error("database password is hunter2");
          });
          parent.route("/", router);
          return router;
        },
      ],
    });
    const response = await app.request("/boom");
    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).not.toContain("hunter2");
    expect(JSON.parse(body)).toEqual({
      error: { code: "internal", message: "Something went wrong on our side." },
    });
    expect(logs.some((line) => line.includes('"msg":"unhandled error"'))).toBe(true);
  });
});

describe("logging", () => {
  it("never writes passwords, cookies or token secrets", async () => {
    const wrongPassword = testPassword("wrong");
    const { app, deps, logs } = createTestApp(testDb.db);
    const user = await insertUser(testDb.db);
    const { cookie } = await login(app, user.email);
    await send(app, "POST", "/api/auth/login", {
      body: { email: user.email, password: wrongPassword },
    });
    const created = await send(app, "POST", "/api/tokens", {
      cookie,
      body: { name: "logs", scopes: ["mcp:read"] },
    });
    const { secret } = (await created.json()) as { secret: string };
    const device = await createTokensService(deps).create({
      userId: user.id,
      kind: "device",
      name: "d",
      scopes: ["bridge"],
    });
    deps.logger.info(
      { headers: { authorization: `Bearer ${device.secret}`, cookie }, password: PASSWORD },
      "careless",
    );

    const output = logs.join("");
    expect(logs.length).toBeGreaterThan(3);
    for (const sensitive of [
      PASSWORD,
      wrongPassword,
      secret,
      device.secret,
      cookie.split("=")[1] ?? "",
    ]) {
      expect(output).not.toContain(sensitive);
    }
    expect(output).toContain("[redacted]");
  });
});

describe("web app in production", () => {
  let webDir: string;

  beforeAll(async () => {
    webDir = await mkdtemp(join(tmpdir(), "loomcast-web-"));
    await mkdir(join(webDir, "assets"));
    await writeFile(join(webDir, "index.html"), "<!doctype html><title>Loomcast</title>");
    await writeFile(join(webDir, "assets", "app-abc123.js"), "console.log('app');");
    await writeFile(join(webDir, "theme-init.js"), "void 0;");
  });

  afterAll(async () => {
    await rm(webDir, { recursive: true, force: true });
  });

  function productionApp() {
    return createTestApp(testDb.db, {
      config: { nodeEnv: "production", isProduction: true, webDistDir: webDir },
    }).app;
  }

  it("serves files with long-lived caching for hashed assets", async () => {
    const app = productionApp();
    const asset = await app.request("/assets/app-abc123.js");
    expect(asset.status).toBe(200);
    expect(await asset.text()).toBe("console.log('app');");
    expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");

    const script = await app.request("/theme-init.js");
    expect(script.status).toBe(200);
    expect(script.headers.get("cache-control")).toBe("no-cache");
  });

  it("falls back to index.html for client routes", async () => {
    const app = productionApp();
    for (const path of ["/", "/projects/sample-project", "/settings/tokens"]) {
      const response = await app.request(path);
      expect(response.status, path).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/html");
      expect(await response.text()).toContain("<title>Loomcast</title>");
    }
  });

  it("leaves server paths and missing files alone", async () => {
    const app = productionApp();
    expect((await app.request("/api/projects")).status).toBe(401);
    expect((await app.request("/healthz")).status).toBe(200);
    expect((await app.request("/assets/missing.js")).status).toBe(404);
    expect((await app.request("/mcp")).status).toBe(401);
  });

  it("does not serve the web app outside production", async () => {
    const { app } = createTestApp(testDb.db, { config: { webDistDir: webDir } });
    expect((await app.request("/")).status).toBe(404);
  });
});

describe("startServer", () => {
  it("exposes the HTTP server to modules, serves requests and shuts down gracefully", async () => {
    const logger = createLogger({ level: "silent" });
    const lifecycle = createLifecycle(logger);
    let closed = false;
    lifecycle.onClose(() => {
      closed = true;
    });
    const deps: AppDeps = {
      db: testDb.db,
      bus: createEventBus(logger),
      clock: createTestClock(),
      logger,
      config: testConfig(),
      lifecycle,
    };
    // The bridge module reaches the server the same way: through deps, at register time.
    let serverSeenByModule: unknown;
    const running = await startServer(deps, {
      port: 0,
      host: "127.0.0.1",
      modules: [
        (app, moduleDeps) => {
          serverSeenByModule = moduleDeps.httpServer;
          return app;
        },
      ],
    });
    expect(serverSeenByModule).toBe(running.server);
    expect(running.port).toBeGreaterThan(0);

    const user = await insertUser(testDb.db);
    const base = `http://127.0.0.1:${running.port}`;
    const health = await fetch(`${base}/healthz`);
    expect(health.status).toBe(200);
    const loginResponse = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: {
        Origin: "http://localhost:5173",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email: user.email, password: PASSWORD }),
    });
    expect(loginResponse.status).toBe(200);

    await running.close(1_000);
    expect(closed).toBe(true);
    expect(running.server.listening).toBe(false);
    await expect(fetch(`${base}/healthz`)).rejects.toThrow();
  });
});
