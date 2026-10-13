import type { Clock } from "./clock";

/**
 * Status of one readiness check. `skipped` means the dependency is not in use in this process
 * (object storage without S3 settings, a disabled scheduler); only `error` makes the app unready.
 */
export type CheckStatus = "ok" | "error" | "skipped";

/** What a check returns: nothing (ok), a status, or a status with a short detail. */
export type CheckOutcome = undefined | CheckStatus | { status: CheckStatus; detail?: string };

/**
 * A readiness check. It throws, or returns `error`, when its dependency is unusable. `signal`
 * aborts when the check times out; pass it to the request the check makes.
 */
export type HealthCheck = (signal: AbortSignal) => Promise<CheckOutcome> | CheckOutcome;

export interface CheckResult {
  status: CheckStatus;
  /** Why a check failed or was skipped. Owner-facing and logged; `/readyz` leaves it out. */
  detail?: string;
  durationMs: number;
}

export interface ReadinessReport {
  /** False when any check reports `error`. */
  ok: boolean;
  checks: Record<string, CheckResult>;
}

export interface RegisterCheckOptions {
  /** Defaults to the registry's timeout (2 s). */
  timeoutMs?: number;
}

/**
 * The readiness checks behind `/readyz`. `createApp` registers the database, object storage and
 * scheduler checks; a module that owns another dependency registers its own in `register`.
 */
export interface HealthRegistry {
  register(name: string, check: HealthCheck, options?: RegisterCheckOptions): void;
  names(): string[];
  /** Runs every check at once, each bounded by its timeout. Never throws. */
  run(): Promise<ReadinessReport>;
}

/** How long one check may take before it counts as failed. */
export const DEFAULT_CHECK_TIMEOUT_MS = 2_000;

class CheckTimeout extends Error {
  constructor(ms: number) {
    super(`timed out after ${ms} ms`);
    this.name = "CheckTimeout";
  }
}

function normalize(outcome: CheckOutcome): { status: CheckStatus; detail?: string } {
  if (outcome === undefined) {
    return { status: "ok" };
  }
  return typeof outcome === "string" ? { status: outcome } : outcome;
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name;
  }
  return String(error);
}

async function runCheck(check: HealthCheck, timeoutMs: number): Promise<CheckResult> {
  const started = performance.now();
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new CheckTimeout(timeoutMs);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    const outcome = await Promise.race([
      Promise.resolve().then(() => check(controller.signal)),
      timeout,
    ]);
    return { ...normalize(outcome), durationMs: Math.round(performance.now() - started) };
  } catch (error) {
    return {
      status: "error",
      detail: describe(error),
      durationMs: Math.round(performance.now() - started),
    };
  } finally {
    clearTimeout(timer);
  }
}

export function createHealthRegistry(options: { timeoutMs?: number } = {}): HealthRegistry {
  const defaultTimeout = options.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
  const checks = new Map<string, { check: HealthCheck; timeoutMs: number }>();

  return {
    register(name, check, registerOptions = {}) {
      if (checks.has(name)) {
        throw new Error(`readiness check "${name}" is already registered`);
      }
      checks.set(name, { check, timeoutMs: registerOptions.timeoutMs ?? defaultTimeout });
    },
    names() {
      return [...checks.keys()];
    },
    async run() {
      const entries = [...checks.entries()];
      const results = await Promise.all(
        entries.map(([, entry]) => runCheck(entry.check, entry.timeoutMs)),
      );
      const report: ReadinessReport = { ok: true, checks: {} };
      entries.forEach(([name], index) => {
        const result = results[index] as CheckResult;
        report.checks[name] = result;
        if (result.status === "error") {
          report.ok = false;
        }
      });
      return report;
    },
  };
}

export interface CachedCheckOptions {
  clock: Clock;
  /** How long a good result is reused. */
  ttlMs: number;
  /** How long a failure is reused; shorter, so recovery shows quickly. Defaults to `ttlMs`. */
  errorTtlMs?: number;
}

/**
 * Wraps a check whose dependency is costly to probe (object storage bills each request). Callers
 * within `ttlMs` share the last result, and concurrent callers share one probe.
 */
export function cachedCheck(check: HealthCheck, options: CachedCheckOptions): HealthCheck {
  const errorTtlMs = options.errorTtlMs ?? options.ttlMs;
  let cached: { at: number; ttlMs: number; result: Promise<CheckOutcome> } | null = null;

  return (signal) => {
    const now = options.clock.now().getTime();
    if (cached !== null && now - cached.at < cached.ttlMs) {
      return cached.result;
    }
    const entry = {
      at: now,
      ttlMs: options.ttlMs,
      result: Promise.resolve().then(() => check(signal)),
    };
    entry.result.then(
      (outcome) => {
        if (normalize(outcome).status === "error") {
          entry.ttlMs = errorTtlMs;
        }
      },
      () => {
        entry.ttlMs = errorTtlMs;
      },
    );
    cached = entry;
    return entry.result;
  };
}
