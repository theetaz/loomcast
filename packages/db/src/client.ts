import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

export type Schema = typeof schema;
export type Database = NodePgDatabase<Schema>;

export interface CreateDbOptions {
  /** Most connections the pool opens. Defaults to 10. */
  max?: number;
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
  const db = drizzle({ client: pool, schema });
  return { db, pool, close: () => pool.end() };
}
