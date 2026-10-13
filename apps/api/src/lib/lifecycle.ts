import type { Logger } from "./logger";

export type CloseHook = () => void | Promise<void>;

/**
 * Shutdown hooks. Modules that hold sockets, timers or streams register a hook; `close()` runs them
 * once, newest first, during graceful shutdown.
 */
export interface Lifecycle {
  /** True once shutdown has started; `/readyz` then reports unavailable. */
  readonly closing: boolean;
  onClose(hook: CloseHook): void;
  close(): Promise<void>;
}

export function createLifecycle(logger?: Logger): Lifecycle {
  const hooks: CloseHook[] = [];
  let closing = false;
  let closed: Promise<void> | null = null;

  return {
    get closing() {
      return closing;
    },
    onClose(hook) {
      hooks.push(hook);
    },
    close() {
      closing = true;
      closed ??= (async () => {
        for (const hook of hooks.reverse()) {
          try {
            await hook();
          } catch (error) {
            logger?.error({ err: error }, "shutdown hook failed");
          }
        }
      })();
      return closed;
    },
  };
}
