import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client } from "pg";
import { type Config, loadConfig } from "../env";
import { createLogger, type Logger } from "../lib/logger";

// Production entry point: apply pending migrations under a Postgres advisory lock, then start the
// API in the same process. Two containers starting at once queue on the lock; the second finds
// nothing left to apply. `--migrate-only` stops after migrating.

/** Name hashed into the advisory lock key with `hashtext`. */
export const MIGRATION_LOCK_NAME = "loomcast:migrate";

export interface MigrateWithLockOptions {
  databaseUrl: string;
  /** Folder holding the SQL files and `meta/_journal.json`. */
  migrationsDir: string;
  logger?: Logger;
}

export interface MigrateResult {
  /** Migrations recorded before this run. */
  before: number;
  /** Migrations recorded after this run. */
  after: number;
}

/**
 * The db package's migrations in a checkout. `src/cli` and `dist/cli` sit at the same depth, so the
 * path holds for both. Not imported from `@loomcast/db`: bundling its migrate module would also
 * bundle that module's own run-when-main block into this entry.
 */
const CHECKOUT_MIGRATIONS_DIR = fileURLToPath(
  new URL("../../../../packages/db/migrations", import.meta.url),
);

/** The migrations folder: `MIGRATIONS_DIR` (set in the image), else the checkout's. */
export function resolveMigrationsDir(
  env: Record<string, string | undefined> = process.env,
): string {
  const configured = env.MIGRATIONS_DIR;
  return configured === undefined || configured === "" ? CHECKOUT_MIGRATIONS_DIR : configured;
}

async function appliedCount(client: Client): Promise<number> {
  const table = await client.query<{ exists: boolean }>(
    "select to_regclass('drizzle.__drizzle_migrations') is not null as exists",
  );
  if (table.rows[0]?.exists !== true) {
    return 0;
  }
  const result = await client.query<{ count: number }>(
    "select count(*)::int as count from drizzle.__drizzle_migrations",
  );
  return result.rows[0]?.count ?? 0;
}

/**
 * Applies every pending migration on a dedicated connection while holding
 * `pg_advisory_lock(hashtext('loomcast:migrate'))`. The lock is a session lock, so it is released
 * even if the process dies mid-run; the migrator applies the pending batch in one transaction.
 */
export async function migrateWithLock(options: MigrateWithLockOptions): Promise<MigrateResult> {
  const { databaseUrl, migrationsDir, logger } = options;
  if (!existsSync(join(migrationsDir, "meta", "_journal.json"))) {
    throw new Error(`No migrations journal in ${migrationsDir}; set MIGRATIONS_DIR.`);
  }
  const client = new Client({
    connectionString: databaseUrl,
    application_name: "loomcast-migrate",
  });
  await client.connect();
  try {
    logger?.info("waiting for the migration lock");
    await client.query("select pg_advisory_lock(hashtext($1))", [MIGRATION_LOCK_NAME]);
    try {
      const before = await appliedCount(client);
      await migrate(drizzle({ client }), { migrationsFolder: migrationsDir });
      const after = await appliedCount(client);
      return { before, after };
    } finally {
      // Closing the connection releases the lock too, so a failed unlock is only logged.
      await client
        .query("select pg_advisory_unlock(hashtext($1))", [MIGRATION_LOCK_NAME])
        .catch((error: unknown) => logger?.warn({ err: error }, "migration unlock failed"));
    }
  } finally {
    await client.end();
  }
}

async function run(argv: readonly string[]): Promise<void> {
  let config: Config;
  try {
    config = loadConfig();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
    return;
  }
  const logger = createLogger({ level: config.logLevel }).child({ component: "migrate" });
  const migrationsDir = resolveMigrationsDir();
  try {
    const { before, after } = await migrateWithLock({
      databaseUrl: config.databaseUrl,
      migrationsDir,
      logger,
    });
    logger.info({ applied: after - before, total: after }, "migrations up to date");
  } catch (error) {
    logger.error({ err: error }, "migration failed");
    process.exitCode = 1;
    return;
  }
  if (argv.includes("--migrate-only")) {
    return;
  }
  const server = await import("../server");
  await server.main();
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && realpathSync(entry) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  run(process.argv.slice(2)).catch((error: unknown) => {
    console.error("api failed to start:", error);
    process.exitCode = 1;
  });
}
