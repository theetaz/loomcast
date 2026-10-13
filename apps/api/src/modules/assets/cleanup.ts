import type { Logger } from "../../lib/logger";
import type { AssetsService } from "./service";

/** How often stale pending uploads are deleted. The scheduler takes this over in M4. */
export const PENDING_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

export interface PendingUploadCleanup {
  /** Runs one pass now. */
  run(): Promise<number>;
  start(): void;
  stop(): void;
}

/** An in-process timer that runs `cleanupPendingUploads` every `intervalMs`, one pass at a time. */
export function createPendingUploadCleanup(
  assets: Pick<AssetsService, "cleanupPendingUploads">,
  logger: Logger,
  intervalMs = PENDING_CLEANUP_INTERVAL_MS,
): PendingUploadCleanup {
  let timer: NodeJS.Timeout | null = null;
  let running: Promise<number> | null = null;

  function run(): Promise<number> {
    running ??= assets
      .cleanupPendingUploads()
      .catch((error: unknown) => {
        logger.error({ err: error }, "pending upload cleanup failed");
        return 0;
      })
      .finally(() => {
        running = null;
      });
    return running;
  }

  return {
    run,
    start() {
      if (timer !== null || intervalMs <= 0) {
        return;
      }
      timer = setInterval(() => void run(), intervalMs);
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
