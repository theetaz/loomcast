import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate as runMigrations } from "drizzle-orm/node-postgres/migrator";
import { Client } from "pg";
import { isMainModule } from "./cli";
import { requireEnv } from "./env";

/** Absolute path of the committed SQL migrations. */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL("../migrations", import.meta.url));

/** Arbitrary constant that identifies the migration lock among advisory locks. */
const MIGRATION_LOCK_KEY = 7_204_519_001;

/**
 * Applies every pending migration in `MIGRATIONS_FOLDER` to the database at `url`. Applied
 * migrations are recorded in `drizzle.__drizzle_migrations`, so running it again is a no-op.
 * A session advisory lock serialises concurrent runs, for example two api instances starting.
 */
export async function migrate(url: string): Promise<void> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("select pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    try {
      await runMigrations(drizzle({ client }), { migrationsFolder: MIGRATIONS_FOLDER });
    } finally {
      await client.query("select pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]);
    }
  } finally {
    await client.end();
  }
}

if (isMainModule(import.meta.url)) {
  const url = requireEnv("DATABASE_URL");
  migrate(url).then(
    () => console.log(`Migrations applied to ${new URL(url).pathname.slice(1)}`),
    (error: unknown) => {
      console.error("Migration failed:", error);
      process.exitCode = 1;
    },
  );
}
