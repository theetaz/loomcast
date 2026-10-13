import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb, type TestDb } from "@loomcast/db/testing";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import packageJson from "../package.json" with { type: "json" };
import type { Alert } from "../src/lib/alerts";
import { createLogger } from "../src/lib/logger";
import {
  BACKUP_STALE_AFTER_HOURS,
  backupAlert,
  createBackupMonitor,
  type OpsStatus,
  readBackupStatus,
} from "../src/modules/ops";
import { createTestApp, createTestClock, errorCode, insertUser, login, send } from "./support";

const HOUR_MS = 60 * 60 * 1000;
const silent = createLogger({ level: "silent" });

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "loomcast-ops-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Writes what the backup service writes after a successful run at `at`. */
async function writeSuccess(at: Date, extra: Record<string, unknown> = {}): Promise<void> {
  await writeFile(
    join(dir, "last-success.json"),
    JSON.stringify({
      at: at.toISOString().replace(/\.\d{3}Z$/, "Z"),
      bytes: 123_456,
      file: "daily/loomcast-20261013T023000Z.dump",
      weekly: false,
      uploaded: "daily/loomcast-20261013T023000Z.dump.age",
      encrypted: true,
      durationSeconds: 4,
      ...extra,
    }),
  );
}

describe("backup status", () => {
  const now = new Date("2026-10-13T12:00:00.000Z");

  it("is not_configured without a directory and missing before the first backup", async () => {
    expect((await readBackupStatus(null, now)).status).toBe("not_configured");
    expect((await readBackupStatus(dir, now)).status).toBe("missing");
  });

  it("reports a recent backup with its age, file and off-site copy", async () => {
    await writeSuccess(new Date(now.getTime() - 9.5 * HOUR_MS));
    expect(await readBackupStatus(dir, now)).toEqual({
      status: "ok",
      staleAfterHours: BACKUP_STALE_AFTER_HOURS,
      lastSuccessAt: "2026-10-13T02:30:00Z",
      ageHours: 9.5,
      file: "daily/loomcast-20261013T023000Z.dump",
      bytes: 123_456,
      uploaded: true,
      encrypted: true,
      lastFailureAt: null,
      lastFailureError: null,
    });
  });

  it("is stale after 26 hours and shows a failure newer than the last success", async () => {
    await writeSuccess(new Date(now.getTime() - 27 * HOUR_MS), {
      uploaded: null,
      encrypted: false,
    });
    await writeFile(
      join(dir, "last-failure.json"),
      JSON.stringify({ at: "2026-10-13T02:30:05Z", error: "pg_dump: connection refused" }),
    );
    const status = await readBackupStatus(dir, now);
    expect(status).toMatchObject({
      status: "stale",
      ageHours: 27,
      uploaded: false,
      encrypted: false,
      lastFailureAt: "2026-10-13T02:30:05Z",
      lastFailureError: "pg_dump: connection refused",
    });
  });

  it("is unreadable when the file is not what the backup service writes", async () => {
    await writeFile(join(dir, "last-success.json"), "{not json");
    expect((await readBackupStatus(dir, now)).status).toBe("unreadable");
    await writeFile(join(dir, "last-success.json"), JSON.stringify({ at: "yesterday" }));
    expect((await readBackupStatus(dir, now)).status).toBe("unreadable");
  });

  it("alerts on stale and unreadable, and on missing only after the grace period", async () => {
    const stale = await (async () => {
      await writeSuccess(new Date(now.getTime() - 30 * HOUR_MS));
      return readBackupStatus(dir, now);
    })();
    expect(backupAlert(stale, 0)?.key).toBe("backup.stale");

    const missing = await readBackupStatus(join(dir, "empty"), now);
    expect(missing.status).toBe("missing");
    expect(backupAlert(missing, 25 * HOUR_MS)).toBeNull();
    expect(backupAlert(missing, 27 * HOUR_MS)?.key).toBe("backup.stale");

    expect(backupAlert({ ...missing, status: "unreadable" }, 0)?.key).toBe("backup.unreadable");
    expect(backupAlert({ ...missing, status: "ok" }, 0)).toBeNull();
    expect(backupAlert({ ...missing, status: "not_configured" }, 0)).toBeNull();
  });

  it("checks right away when started and stops with the returned function", async () => {
    const clock = createTestClock(now);
    const alerts: Alert[] = [];
    await writeSuccess(new Date(now.getTime() - 40 * HOUR_MS));
    const monitor = createBackupMonitor({
      dir,
      clock,
      logger: silent,
      alert: async (alert) => {
        alerts.push(alert);
      },
      startedAt: now,
    });
    const stop = monitor.start();
    await vi.waitFor(() => expect(alerts.map((alert) => alert.key)).toEqual(["backup.stale"]));
    stop();
  });
});

describe("GET /api/ops/status", () => {
  let testDb: TestDb;
  let ownerEmail: string;
  let adminEmail: string;

  beforeAll(async () => {
    testDb = await createTestDb();
    ownerEmail = (await insertUser(testDb.db, { role: "owner" })).email;
    adminEmail = (await insertUser(testDb.db, { role: "admin" })).email;
  });

  afterAll(async () => {
    await testDb.drop();
  });

  it("needs a session and the owner role", async () => {
    const { app } = createTestApp(testDb.db, { config: { storage: null } });
    const anonymous = await send(app, "GET", "/api/ops/status");
    expect(anonymous.status).toBe(401);
    const { cookie } = await login(app, adminEmail);
    const admin = await send(app, "GET", "/api/ops/status", { cookie });
    expect(admin.status).toBe(403);
    expect(await errorCode(admin)).toBe("forbidden");
  });

  it("reports version, uptime, readiness, the scheduler and the last backup", async () => {
    const sha = "0123456789ab";
    const { app, clock, deps } = createTestApp(testDb.db, {
      config: { storage: null, gitSha: sha, backupDir: dir },
    });
    const alerts: Alert[] = [];
    deps.alert = (alert) => {
      alerts.push(alert);
    };
    await writeSuccess(new Date(clock.now().getTime() - 2 * HOUR_MS));
    const { cookie } = await login(app, ownerEmail);
    clock.advance(90_000);

    const response = await send(app, "GET", "/api/ops/status", { cookie });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as OpsStatus;
    expect(body).toMatchObject({
      version: packageJson.version,
      gitSha: sha,
      environment: "test",
      uptimeSeconds: 90,
      readiness: {
        status: "ok",
        checks: {
          database: { status: "ok" },
          storage: { status: "skipped" },
          scheduler: { status: "skipped", detail: "disabled" },
        },
      },
      scheduler: {
        status: "disabled",
        running: false,
        lastTickAt: null,
        queueDepths: { pending: 0, running: 0, succeeded: 0, failed: 0, dead: 0 },
      },
      backup: { status: "ok", uploaded: true, encrypted: true },
      alerts: { configured: false, format: "json" },
    });
    expect(alerts).toEqual([]);

    clock.advance(25 * HOUR_MS);
    const stale = (await (
      await send(app, "GET", "/api/ops/status", { cookie })
    ).json()) as OpsStatus;
    expect(stale.backup.status).toBe("stale");
    expect(alerts.map((alert) => alert.key)).toEqual(["backup.stale"]);
  });

  it("shows failing readiness checks with their reason", async () => {
    const { app } = createTestApp(testDb.db);
    const { cookie } = await login(app, ownerEmail);
    const body = (await (
      await send(app, "GET", "/api/ops/status", { cookie })
    ).json()) as OpsStatus;
    expect(body.readiness.status).toBe("unavailable");
    expect(body.readiness.checks.storage?.status).toBe("error");
    expect(body.readiness.checks.storage?.detail).toMatch(/^HEAD bucket loomcast-media failed/);
    expect(body.backup.status).toBe("not_configured");
  });
});
