import type { Logger } from "../../lib/logger";
import type { JobLifecycle, SweptJob } from "./lifecycle";

/** How often the reaper looks for expired leases. */
export const REAPER_INTERVAL_MS = 15_000;

export interface Reaper {
  /**
   * Applies the registry's lease-expiry policy to every running job whose lease has passed:
   * `producer.chat` fails as `interrupted` (retryable), idempotent types go back to the queue
   * while `attempt < max_attempts`, and a job with a pending cancel request ends as cancelled.
   */
  sweep(): Promise<SweptJob[]>;
  /** Sweeps every `intervalMs` until `stop`. An interval of 0 never starts the timer. */
  start(): void;
  stop(): void;
}

export interface ReaperDeps {
  lifecycle: JobLifecycle;
  logger: Logger;
  intervalMs?: number;
  /** Called with the jobs each sweep changed, for example to stop them on their agent. */
  onSwept?: (swept: SweptJob[]) => void;
}

export function createReaper(deps: ReaperDeps): Reaper {
  const { lifecycle, logger } = deps;
  const intervalMs = deps.intervalMs ?? REAPER_INTERVAL_MS;
  let timer: NodeJS.Timeout | null = null;
  let sweeping: Promise<SweptJob[]> | null = null;

  async function sweep(): Promise<SweptJob[]> {
    const swept = await lifecycle.expireLeases();
    for (const { job, previousDevice } of swept) {
      logger.info(
        { jobId: job.id, jobType: job.type, status: job.status, deviceId: previousDevice },
        "job lease expired",
      );
    }
    if (swept.length > 0) {
      deps.onSwept?.(swept);
    }
    return swept;
  }

  return {
    sweep,
    start() {
      if (timer !== null || intervalMs <= 0) {
        return;
      }
      timer = setInterval(() => {
        if (sweeping !== null) {
          return;
        }
        sweeping = sweep()
          .catch((error: unknown) => {
            logger.error({ err: error }, "lease sweep failed");
            return [];
          })
          .finally(() => {
            sweeping = null;
          });
      }, intervalMs);
      timer.unref();
    },
    stop() {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
