import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Alert } from "../../lib/alerts";
import type { Clock } from "../../lib/clock";
import type { Logger } from "../../lib/logger";

const HOUR_MS = 60 * 60 * 1000;

/** A backup older than this is stale: the nightly run has been missed. */
export const BACKUP_STALE_AFTER_HOURS = 26;
export const BACKUP_STALE_AFTER_MS = BACKUP_STALE_AFTER_HOURS * HOUR_MS;

/** How often a served api re-reads `last-success.json`. */
export const BACKUP_CHECK_INTERVAL_MS = HOUR_MS;

/**
 * `ok`: the last backup is recent. `stale`: older than 26 hours. `missing`: no backup has
 * succeeded yet. `unreadable`: the file or directory cannot be read or parsed (check the mount).
 * `not_configured`: no `BACKUP_DIR` (development).
 */
export type BackupState = "ok" | "stale" | "missing" | "unreadable" | "not_configured";

export interface BackupStatus {
  status: BackupState;
  staleAfterHours: number;
  lastSuccessAt: string | null;
  /** Hours since the last success, to one decimal. */
  ageHours: number | null;
  /** Relative to the backup directory, for example `daily/loomcast-<stamp>.dump`. */
  file: string | null;
  bytes: number | null;
  /** True when an off-site copy was uploaded. */
  uploaded: boolean | null;
  encrypted: boolean | null;
  /** Set when the last run failed after the last success. */
  lastFailureAt: string | null;
  lastFailureError: string | null;
}

/** What the backup service writes to `last-success.json` (see infra/backup/backup.sh). */
const LastSuccessSchema = z.object({
  at: z.iso.datetime(),
  bytes: z.number().int().nonnegative().optional(),
  file: z.string().optional(),
  uploaded: z.string().nullable().optional(),
  encrypted: z.boolean().optional(),
});

const LastFailureSchema = z.object({
  at: z.iso.datetime(),
  error: z.string().optional(),
});

const EMPTY: Omit<BackupStatus, "status"> = {
  staleAfterHours: BACKUP_STALE_AFTER_HOURS,
  lastSuccessAt: null,
  ageHours: null,
  file: null,
  bytes: null,
  uploaded: null,
  encrypted: null,
  lastFailureAt: null,
  lastFailureError: null,
};

/** The file's contents, or null when it does not exist. Other errors propagate. */
async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function lastFailure(
  dir: string,
): Promise<{ lastFailureAt: string; lastFailureError: string | null } | null> {
  try {
    const parsed = LastFailureSchema.safeParse(await readJson(join(dir, "last-failure.json")));
    if (!parsed.success) {
      return null;
    }
    return {
      lastFailureAt: parsed.data.at,
      lastFailureError: parsed.data.error?.slice(0, 300) ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * Reads `last-success.json` (and `last-failure.json`) by name. The directory is mode 0711 on the
 * host, so the api can open these files but not list the backups.
 */
export async function readBackupStatus(dir: string | null, now: Date): Promise<BackupStatus> {
  if (dir === null) {
    return { status: "not_configured", ...EMPTY };
  }
  let raw: unknown;
  try {
    raw = await readJson(join(dir, "last-success.json"));
  } catch {
    return { status: "unreadable", ...EMPTY };
  }
  const failure = await lastFailure(dir);
  if (raw === null) {
    return { status: "missing", ...EMPTY, ...failure };
  }
  const parsed = LastSuccessSchema.safeParse(raw);
  if (!parsed.success) {
    return { status: "unreadable", ...EMPTY, ...failure };
  }
  const success = parsed.data;
  const ageMs = Math.max(0, now.getTime() - Date.parse(success.at));
  const failedSince =
    failure !== null && Date.parse(failure.lastFailureAt) > Date.parse(success.at);
  return {
    status: ageMs > BACKUP_STALE_AFTER_MS ? "stale" : "ok",
    staleAfterHours: BACKUP_STALE_AFTER_HOURS,
    lastSuccessAt: success.at,
    ageHours: Math.round(ageMs / (HOUR_MS / 10)) / 10,
    file: success.file ?? null,
    bytes: success.bytes ?? null,
    uploaded: success.uploaded === undefined ? null : success.uploaded !== null,
    encrypted: success.encrypted ?? null,
    lastFailureAt: failedSince ? (failure?.lastFailureAt ?? null) : null,
    lastFailureError: failedSince ? (failure?.lastFailureError ?? null) : null,
  };
}

/**
 * The alert a backup status calls for, if any. `missing` alerts only once the api has run for
 * longer than the stale window, so a fresh install has time for its first nightly backup.
 */
export function backupAlert(status: BackupStatus, uptimeMs: number): Alert | null {
  switch (status.status) {
    case "stale":
      return {
        key: "backup.stale",
        title: "Loomcast backup is stale",
        message: `The last successful backup is ${status.ageHours} hours old (limit ${BACKUP_STALE_AFTER_HOURS} hours).`,
        data: {
          lastSuccessAt: status.lastSuccessAt,
          lastFailureAt: status.lastFailureAt,
        },
      };
    case "missing":
      if (uptimeMs <= BACKUP_STALE_AFTER_MS) {
        return null;
      }
      return {
        key: "backup.stale",
        title: "Loomcast backup is missing",
        message: `No backup has succeeded in the ${BACKUP_STALE_AFTER_HOURS} hours since the api started.`,
        data: { lastSuccessAt: null, lastFailureAt: status.lastFailureAt },
      };
    case "unreadable":
      return {
        key: "backup.unreadable",
        title: "Loomcast backup status is unreadable",
        message:
          "The api cannot read last-success.json in the backup directory. Check the read-only mount and the file.",
        data: {},
      };
    default:
      return null;
  }
}

export interface BackupMonitor {
  /** Reads the status and raises an alert when it calls for one. */
  check(): Promise<BackupStatus>;
  /** Checks now and then every hour; returns the function that stops it. */
  start(): () => void;
}

export interface BackupMonitorDeps {
  dir: string | null;
  clock: Clock;
  logger: Logger;
  alert: (alert: Alert) => Promise<void>;
  /** When this process started, for the grace period of `missing`. */
  startedAt: Date;
}

export function createBackupMonitor(deps: BackupMonitorDeps): BackupMonitor {
  async function check(): Promise<BackupStatus> {
    const now = deps.clock.now();
    const status = await readBackupStatus(deps.dir, now);
    const alert = backupAlert(status, now.getTime() - deps.startedAt.getTime());
    if (alert !== null) {
      await deps.alert(alert);
    }
    return status;
  }

  return {
    check,
    start() {
      const run = () => {
        check().catch((error: unknown) => {
          deps.logger.error({ err: error }, "backup status check failed");
        });
      };
      run();
      const timer = setInterval(run, BACKUP_CHECK_INTERVAL_MS);
      timer.unref();
      return () => clearInterval(timer);
    },
  };
}
