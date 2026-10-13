import { Hono } from "hono";
import packageJson from "../../../package.json" with { type: "json" };
import type { ModuleDeps } from "../../deps";
import type { AlertFormat } from "../../lib/alerts";
import { forbidden } from "../../lib/errors";
import type { CheckResult } from "../../lib/health";
import type { AppEnv } from "../../types";
import { currentUser } from "../auth/guards";
import type { SchedulerHealth } from "../scheduler/scheduler";
import { type BackupStatus, createBackupMonitor } from "./backup";

export {
  BACKUP_CHECK_INTERVAL_MS,
  BACKUP_STALE_AFTER_HOURS,
  type BackupState,
  type BackupStatus,
  backupAlert,
  createBackupMonitor,
  readBackupStatus,
} from "./backup";
export {
  databaseCheck,
  STORAGE_CHECK_ERROR_TTL_MS,
  STORAGE_CHECK_TTL_MS,
  schedulerCheck,
  storageCheck,
} from "./checks";

/** Owner-only operations status. Not in the contracts yet: the web app does not show it. */
export const OPS_STATUS_PATH = "/api/ops/status";

export interface OpsStatus {
  version: string;
  /** Commit the image was built from, or null outside a release build. */
  gitSha: string | null;
  environment: string;
  startedAt: string;
  uptimeSeconds: number;
  checkedAt: string;
  readiness: { status: "ok" | "unavailable"; checks: Record<string, CheckResult> };
  scheduler: SchedulerHealth & {
    /** Tasks per status, or null when the database could not be read. */
    queueDepths: Record<string, number> | null;
  };
  backup: BackupStatus;
  alerts: { configured: boolean; format: AlertFormat };
}

/**
 * `GET /api/ops/status` for the owner: version, uptime, readiness details, the scheduler's last
 * tick and queue depths, and the last backup. In a served process it also re-reads the backup
 * status every hour and alerts when the last backup is older than 26 hours.
 */
export function register(app: Hono<AppEnv>, deps: ModuleDeps): Hono<AppEnv> {
  const { config, clock, scheduler } = deps;
  const startedAt = clock.now();
  const backups = createBackupMonitor({
    dir: config.backupDir,
    clock,
    logger: deps.logger.child({ module: "ops" }),
    alert: deps.alert,
    startedAt,
  });
  if (deps.httpServer !== undefined && config.backupDir !== null) {
    deps.lifecycle.onClose(backups.start());
  }

  const router = new Hono<AppEnv>();

  router.get(OPS_STATUS_PATH, async (c) => {
    const user = currentUser(c);
    if (user.role !== "owner") {
      throw forbidden("Only the owner can see the operations status.");
    }
    const [readiness, queueDepths, backup] = await Promise.all([
      deps.health.run(),
      scheduler.queueDepths().catch((error: unknown) => {
        c.get("logger").warn({ err: error }, "could not count scheduled tasks");
        return null;
      }),
      backups.check(),
    ]);
    const now = clock.now();
    const body: OpsStatus = {
      version: packageJson.version,
      gitSha: config.gitSha,
      environment: config.nodeEnv,
      startedAt: startedAt.toISOString(),
      uptimeSeconds: Math.max(0, Math.floor((now.getTime() - startedAt.getTime()) / 1000)),
      checkedAt: now.toISOString(),
      readiness: { status: readiness.ok ? "ok" : "unavailable", checks: readiness.checks },
      scheduler: { ...scheduler.health(), queueDepths },
      backup,
      alerts: { configured: config.alerts.webhookUrl !== null, format: config.alerts.format },
    };
    c.header("Cache-Control", "no-store");
    return c.json(body, 200);
  });

  app.route("/", router);
  return router;
}
