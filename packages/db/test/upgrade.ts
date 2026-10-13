import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate as runMigrations } from "drizzle-orm/node-postgres/migrator";
import { Client } from "pg";
import { MIGRATIONS_FOLDER } from "../src/migrate";

// Helpers for upgrade tests: build a database as an earlier release left it, then migrate it.

interface Journal {
  entries: { tag: string }[];
}

export const journal = JSON.parse(
  readFileSync(join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8"),
) as Journal;

/** A temporary copy of the migrations folder that ends at `lastTag`. Remove it when done. */
export function migrationsUpTo(lastTag: string): string {
  const end = journal.entries.findIndex((entry) => entry.tag === lastTag);
  if (end < 0) throw new Error(`the journal has no ${lastTag}`);
  const entries = journal.entries.slice(0, end + 1);
  const folder = mkdtempSync(join(tmpdir(), "loomcast-previous-migrations-"));
  mkdirSync(join(folder, "meta"));
  for (const entry of entries) {
    copyFileSync(join(MIGRATIONS_FOLDER, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
  }
  writeFileSync(join(folder, "meta", "_journal.json"), JSON.stringify({ ...journal, entries }));
  return folder;
}

/** Applies the migrations in `folder` to the database at `url`. */
export async function migrateFolder(url: string, folder: string): Promise<void> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await runMigrations(drizzle({ client }), { migrationsFolder: folder });
  } finally {
    await client.end();
  }
}
