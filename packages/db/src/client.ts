import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

export type Schema = typeof schema;
export type Database = NodePgDatabase<Schema>;

export interface CreateDbOptions {
  /** Most connections the pool opens. Defaults to 10. */
  max?: number;
  /**
   * Called when an idle pooled connection fails, for example when the server restarts or
   * terminates it. The pool discards the connection and opens a new one on demand.
   */
  onError?: (error: Error) => void;
}

export interface DbHandle {
  db: Database;
  pool: Pool;
  /** Ends every pooled connection. Call once when the process or test is done. */
  close: () => Promise<void>;
}

/** Opens a node-postgres pool for `url` and wraps it in a Drizzle database with the full schema. */
export function createDb(url: string, options: CreateDbOptions = {}): DbHandle {
  const pool = new Pool({ connectionString: url, max: options.max ?? 10 });
  // Without a listener, node-postgres re-emits an idle connection's error on the pool and the
  // process exits on the unhandled error event.
  pool.on("error", (error) => options.onError?.(error));
  const db = drizzle({ client: pool, schema });
  return { db, pool, close: () => pool.end() };
}
