import type { Logger } from "../../lib/logger";

/**
 * Background work started by bus listeners (replanning after a series change, the approval rules).
 * Failures are logged, never thrown at the publisher. `idle()` resolves once nothing is running,
 * so tests and shutdown can wait for the work to settle.
 */
export interface WorkTracker {
  run(label: string, fn: () => Promise<unknown>): void;
  idle(): Promise<void>;
}

export function createWorkTracker(logger: Logger): WorkTracker {
  const running = new Set<Promise<void>>();
  return {
    run(label, fn) {
      const work = (async () => {
        try {
          await fn();
        } catch (error) {
          logger.error({ err: error, work: label }, "background work failed");
        }
      })();
      running.add(work);
      void work.finally(() => running.delete(work));
    },
    async idle() {
      while (running.size > 0) {
        await Promise.all([...running]);
      }
    },
  };
}
