import { HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";
import type { Database } from "@loomcast/db";
import { sql } from "drizzle-orm";
import type { Clock } from "../../lib/clock";
import { cachedCheck, type HealthCheck } from "../../lib/health";
import type { StorageConfig } from "../../lib/storage";
import type { Scheduler } from "../scheduler/scheduler";

/** A good storage result is reused this long, so probes cost one bucket request a minute. */
export const STORAGE_CHECK_TTL_MS = 60_000;

/** A failed storage result is reused only this long, so recovery shows quickly. */
export const STORAGE_CHECK_ERROR_TTL_MS = 10_000;

/** `select 1` on the pool. */
export function databaseCheck(db: Database): HealthCheck {
  return async () => {
    await db.execute(sql`select 1`);
  };
}

/**
 * The scheduler loop. Red only when it is `stalled` (no good tick for six intervals); a disabled
 * scheduler, or one that runs in no loop in this process, is `skipped`.
 */
export function schedulerCheck(scheduler: Pick<Scheduler, "health">): HealthCheck {
  return () => {
    const health = scheduler.health();
    if (health.status === "ok") {
      return "ok";
    }
    if (health.status === "stalled") {
      return {
        status: "error",
        detail: health.lastTickError ?? `no tick since ${health.lastTickAt ?? "the start"}`,
      };
    }
    return { status: "skipped", detail: health.status };
  };
}

export interface StorageCheck {
  check: HealthCheck;
  /** Closes the probe's client. */
  destroy(): void;
}

function describeS3Error(error: unknown): string {
  const fields = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } } | null;
  const name = typeof fields?.name === "string" ? fields.name : "Error";
  const status = fields?.$metadata?.httpStatusCode;
  return typeof status === "number" ? `${name} (http ${status})` : name;
}

/**
 * HEAD on the private bucket, cached for a minute. Uses its own client without retries, so a
 * probe never outlives its timeout. Outside production the API may run without object storage;
 * the check is then `skipped`.
 */
export function storageCheck(config: StorageConfig | null, clock: Clock): StorageCheck {
  if (config === null) {
    return {
      check: () => ({ status: "skipped", detail: "object storage is not configured" }),
      destroy: () => {},
    };
  }
  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: config.forcePathStyle,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    maxAttempts: 1,
    requestHandler: { connectionTimeout: 2_000, requestTimeout: 2_000 },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
  const probe: HealthCheck = async (signal) => {
    try {
      await client.send(new HeadBucketCommand({ Bucket: config.bucket }), { abortSignal: signal });
    } catch (error) {
      if (signal.aborted) {
        throw signal.reason;
      }
      throw new Error(`HEAD bucket ${config.bucket} failed: ${describeS3Error(error)}`);
    }
  };
  return {
    check: cachedCheck(probe, {
      clock,
      ttlMs: STORAGE_CHECK_TTL_MS,
      errorTtlMs: STORAGE_CHECK_ERROR_TTL_MS,
    }),
    destroy: () => client.destroy(),
  };
}
