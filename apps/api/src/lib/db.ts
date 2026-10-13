import type { Database } from "@loomcast/db";

/** A transaction handle, as passed to the callback of `db.transaction`. */
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** Anything queries can run on: the pool-backed database or an open transaction. */
export type Executor = Database | Transaction;

const pendingCallbacks = new WeakMap<object, Array<() => void>>();

/**
 * Runs `fn` in a transaction and, once it commits, the callbacks registered with `afterCommit`.
 * Use it whenever a write publishes bus events, so listeners (for example the job dispatcher) only
 * see rows that are already committed. If the transaction rolls back, the callbacks are dropped.
 */
export async function transaction<T>(
  db: Database,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  const callbacks: Array<() => void> = [];
  const result = await db.transaction(async (tx) => {
    pendingCallbacks.set(tx, callbacks);
    try {
      return await fn(tx);
    } finally {
      pendingCallbacks.delete(tx);
    }
  });
  for (const callback of callbacks) {
    callback();
  }
  return result;
}

/**
 * Runs `callback` after the transaction `executor` belongs to commits, when it was opened with
 * `transaction()`. Otherwise (the plain database, or a transaction opened directly) it runs now.
 */
export function afterCommit(executor: Executor, callback: () => void): void {
  const queue = pendingCallbacks.get(executor);
  if (queue === undefined) {
    callback();
  } else {
    queue.push(callback);
  }
}

/** True when `error` (or the driver error Drizzle wraps in `cause`) is a Postgres unique violation. */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const source = error instanceof Error && error.cause instanceof Error ? error.cause : error;
  const fields = source as { code?: unknown; constraint?: unknown } | null;
  return (
    fields !== null &&
    typeof fields === "object" &&
    fields.code === "23505" &&
    (constraint === undefined || fields.constraint === constraint)
  );
}
