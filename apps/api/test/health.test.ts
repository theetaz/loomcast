import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createTestDb, type TestDb } from "@loomcast/db/testing";
import { Hono } from "hono";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { RegisterModule } from "../src/deps";
import { cachedCheck, createHealthRegistry } from "../src/lib/health";
import {
  STORAGE_CHECK_ERROR_TTL_MS,
  STORAGE_CHECK_TTL_MS,
  schedulerCheck,
} from "../src/modules/ops";
import type { SchedulerHealth } from "../src/modules/scheduler";
import type { AppEnv } from "../src/types";
import { storageConfigFor } from "./storage-support";
import { createTestApp, createTestClock } from "./support";

/** A stand-in S3 endpoint that answers HEAD on the bucket with `status` and counts the calls. */
interface BucketEndpoint {
  endpoint: string;
  heads: number;
  status: number;
  close(): Promise<void>;
}

async function startBucketEndpoint(bucket: string): Promise<BucketEndpoint> {
  const state = { heads: 0, status: 200 };
  const server: Server = createServer((req, res) => {
    if (req.method === "HEAD" && req.url?.split("?")[0]?.replace(/\/$/, "") === `/${bucket}`) {
      state.heads += 1;
      res.writeHead(state.status);
    } else {
      res.writeHead(400);
    }
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${port}`,
    get heads() {
      return state.heads;
    },
    get status() {
      return state.status;
    },
    set status(value: number) {
      state.status = value;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function schedulerHealth(overrides: Partial<SchedulerHealth>): SchedulerHealth {
  return {
    status: "ok",
    workerId: "test",
    running: true,
    lastTickAt: null,
    lastTickError: null,
    inFlight: 0,
    registeredKinds: [],
    ...overrides,
  };
}

describe("health registry", () => {
  it("runs every check and is red only when one reports an error", async () => {
    const health = createHealthRegistry();
    health.register("quiet", () => undefined);
    health.register("plain", async () => "ok" as const);
    health.register("unused", () => ({ status: "skipped", detail: "not configured" }));
    const green = await health.run();
    expect(green.ok).toBe(true);
    expect(green.checks.quiet?.status).toBe("ok");
    expect(green.checks.unused).toMatchObject({ status: "skipped", detail: "not configured" });

    health.register("broken", async () => {
      throw new Error("connection refused");
    });
    const red = await health.run();
    expect(red.ok).toBe(false);
    expect(red.checks.broken).toMatchObject({ status: "error", detail: "connection refused" });
    expect(health.names()).toEqual(["quiet", "plain", "unused", "broken"]);
  });

  it("fails a check that outlives its timeout and aborts its signal", async () => {
    const health = createHealthRegistry({ timeoutMs: 50 });
    let aborted = false;
    health.register(
      "slow",
      (signal) =>
        new Promise<undefined>((resolve) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            resolve(undefined);
          });
        }),
    );
    const report = await health.run();
    expect(report.ok).toBe(false);
    expect(report.checks.slow).toMatchObject({ status: "error", detail: "timed out after 50 ms" });
    expect(aborted).toBe(true);
  });

  it("refuses two checks with the same name", () => {
    const health = createHealthRegistry();
    health.register("database", () => undefined);
    expect(() => health.register("database", () => undefined)).toThrow(/already registered/);
  });

  it("caches results, failures for a shorter time, and shares a probe in flight", async () => {
    const clock = createTestClock();
    let calls = 0;
    let fail = false;
    const check = cachedCheck(
      async () => {
        calls += 1;
        if (fail) {
          throw new Error("down");
        }
      },
      { clock, ttlMs: 60_000, errorTtlMs: 10_000 },
    );
    const signal = new AbortController().signal;
    await Promise.all([check(signal), check(signal)]);
    expect(calls).toBe(1);
    clock.advance(59_000);
    await check(signal);
    expect(calls).toBe(1);

    clock.advance(1_000);
    fail = true;
    await expect(check(signal)).rejects.toThrow("down");
    expect(calls).toBe(2);
    clock.advance(9_000);
    await expect(check(signal)).rejects.toThrow("down");
    expect(calls).toBe(2);

    clock.advance(1_000);
    fail = false;
    await check(signal);
    expect(calls).toBe(3);
  });

  it("maps the scheduler's health: stalled is red, disabled and stopped are skipped", async () => {
    const check = (health: SchedulerHealth) =>
      schedulerCheck({ health: () => health })(new AbortController().signal);
    expect(await check(schedulerHealth({ status: "ok" }))).toBe("ok");
    expect(
      await check(schedulerHealth({ status: "stalled", lastTickError: "connection terminated" })),
    ).toEqual({ status: "error", detail: "connection terminated" });
    expect(await check(schedulerHealth({ status: "disabled", running: false }))).toEqual({
      status: "skipped",
      detail: "disabled",
    });
    expect(await check(schedulerHealth({ status: "stopped", running: false }))).toEqual({
      status: "skipped",
      detail: "stopped",
    });
  });
});

describe("readyz", () => {
  let testDb: TestDb;
  let bucket: BucketEndpoint;

  beforeAll(async () => {
    testDb = await createTestDb();
    bucket = await startBucketEndpoint("loomcast-media");
  });

  afterAll(async () => {
    await bucket.close();
    await testDb.drop();
  });

  afterEach(() => {
    bucket.status = 200;
  });

  it("is green when the database and the storage bucket answer", async () => {
    const { app } = createTestApp(testDb.db, {
      config: { storage: storageConfigFor(bucket.endpoint) },
    });
    const ready = await app.request("/readyz");
    expect(ready.status).toBe(200);
    expect(ready.headers.get("cache-control")).toBe("no-store");
    expect(await ready.json()).toEqual({
      status: "ok",
      checks: { database: "ok", storage: "ok", scheduler: "skipped" },
    });
  });

  it("turns red when object storage is unreachable", async () => {
    // The default test config points storage at a closed port.
    const { app, logs } = createTestApp(testDb.db);
    const ready = await app.request("/readyz");
    expect(ready.status).toBe(503);
    expect(await ready.json()).toEqual({
      status: "unavailable",
      checks: { database: "ok", storage: "error", scheduler: "skipped" },
    });
    expect(logs.some((line) => line.includes("readiness check failed"))).toBe(true);
  });

  it("turns red when the bucket refuses the HEAD", async () => {
    bucket.status = 403;
    const { app } = createTestApp(testDb.db, {
      config: { storage: storageConfigFor(bucket.endpoint) },
    });
    const ready = await app.request("/readyz");
    expect(ready.status).toBe(503);
    expect(await ready.json()).toMatchObject({ checks: { storage: "error" } });
  });

  it("turns red when the database is unreachable", async () => {
    const broken = await createTestDb({ empty: true });
    const { app } = createTestApp(broken.db, {
      config: { storage: storageConfigFor(bucket.endpoint) },
    });
    await broken.drop();
    const ready = await app.request("/readyz");
    expect(ready.status).toBe(503);
    expect(await ready.json()).toMatchObject({
      status: "unavailable",
      checks: { database: "error", storage: "ok" },
    });
  });

  it("HEADs the bucket at most once a minute while it is up, and every 10 s while it is down", async () => {
    const { app, clock } = createTestApp(testDb.db, {
      config: { storage: storageConfigFor(bucket.endpoint) },
    });
    const before = bucket.heads;
    await app.request("/readyz");
    await app.request("/readyz");
    expect(bucket.heads - before).toBe(1);

    clock.advance(STORAGE_CHECK_TTL_MS);
    bucket.status = 503;
    expect((await app.request("/readyz")).status).toBe(503);
    expect(bucket.heads - before).toBe(2);
    bucket.status = 200;
    expect((await app.request("/readyz")).status).toBe(503);
    expect(bucket.heads - before).toBe(2);

    clock.advance(STORAGE_CHECK_ERROR_TTL_MS);
    expect((await app.request("/readyz")).status).toBe(200);
    expect(bucket.heads - before).toBe(3);
  });

  it("skips storage when it is not configured outside production", async () => {
    const { app } = createTestApp(testDb.db, { config: { storage: null } });
    const ready = await app.request("/readyz");
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({ checks: { storage: "skipped" } });
  });

  it("includes checks that modules register", async () => {
    const probe: RegisterModule = (app, deps) => {
      deps.health.register("probe", () => ({ status: "error", detail: "probe failed" }));
      const router = new Hono<AppEnv>();
      app.route("/", router);
      return router;
    };
    const { app } = createTestApp(testDb.db, { config: { storage: null }, modules: [probe] });
    const ready = await app.request("/readyz");
    expect(ready.status).toBe(503);
    expect(await ready.json()).toEqual({
      status: "unavailable",
      checks: { database: "ok", storage: "skipped", scheduler: "skipped", probe: "error" },
    });
  });

  it("reports every check skipped once shutdown starts", async () => {
    const { app, deps } = createTestApp(testDb.db, { config: { storage: null } });
    await deps.lifecycle.close();
    const ready = await app.request("/readyz");
    expect(ready.status).toBe(503);
    expect(await ready.json()).toEqual({
      status: "unavailable",
      checks: { database: "skipped", storage: "skipped", scheduler: "skipped" },
    });
  });

  it("keeps healthz green while readiness is red", async () => {
    const { app } = createTestApp(testDb.db);
    expect((await app.request("/readyz")).status).toBe(503);
    expect((await app.request("/healthz")).status).toBe(200);
  });
});
