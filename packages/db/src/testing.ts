import { createHash, randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { Client, escapeIdentifier } from "pg";
import { createDb, type Database } from "./client";
import { requireEnv } from "./env";
import { MIGRATIONS_FOLDER, migrate } from "./migrate";

// Test-database harness. A vitest globalSetup builds one migrated template database; every test
// file then clones it into its own `t_*` database, which is fast and fully isolated. All databases
// are created through TEST_DATABASE_ADMIN_URL, so parallel worktrees and CI share one server
// without colliding.

const TEMPLATE_PREFIX = "loomcast_template";
const TEST_DB_PREFIX = "t_";
const RUN_ID_ENV = "LOOMCAST_TEST_RUN_ID";

/**
 * Advisory lock taken on the admin database: exclusively while a template is built, shared while
 * one is cloned. Postgres refuses to clone a database that has open connections, so the two must
 * never overlap.
 */
const TEMPLATE_LOCK = "loomcast:test-template";

/** Hash of every file in the migrations folder, so the template name follows the schema. */
function migrationsHash(): string {
  const hash = createHash("sha256");
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else {
        hash.update(relative(MIGRATIONS_FOLDER, path)).update("\0").update(readFileSync(path));
      }
    }
  };
  visit(MIGRATIONS_FOLDER);
  return hash.digest("hex").slice(0, 12);
}

/**
 * Name of the template for the current migrations: `loomcast_template_<hash>`. Worktrees on
 * different branches may carry different migrations, so each schema gets its own template rather
 * than one shared name that a parallel run could rebuild underneath another.
 */
export function templateDatabaseName(): string {
  return `${TEMPLATE_PREFIX}_${migrationsHash()}`;
}

function adminUrl(): string {
  return requireEnv("TEST_DATABASE_ADMIN_URL");
}

function databaseUrl(name: string): string {
  const url = new URL(adminUrl());
  url.pathname = `/${name}`;
  return url.toString();
}

async function withAdmin<T>(run: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: adminUrl() });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

async function withTemplateLock<T>(
  client: Client,
  mode: "exclusive" | "shared",
  run: () => Promise<T>,
): Promise<T> {
  const suffix = mode === "shared" ? "_shared" : "";
  await client.query(`select pg_advisory_lock${suffix}(hashtext($1))`, [TEMPLATE_LOCK]);
  try {
    return await run();
  } finally {
    await client.query(`select pg_advisory_unlock${suffix}(hashtext($1))`, [TEMPLATE_LOCK]);
  }
}

async function dropDatabase(client: Client, name: string): Promise<void> {
  await client.query(`drop database if exists ${escapeIdentifier(name)} with (force)`);
}

/** Builds the template unless a complete one exists. Complete templates are marked IS_TEMPLATE. */
async function ensureTemplate(client: Client, name: string): Promise<void> {
  const existing = await client.query<{ datistemplate: boolean }>(
    "select datistemplate from pg_database where datname = $1",
    [name],
  );
  if (existing.rows[0]?.datistemplate === true) {
    return;
  }
  // A database without the mark is left over from an interrupted build: start again.
  await dropDatabase(client, name);
  await client.query(`create database ${escapeIdentifier(name)}`);
  await migrate(databaseUrl(name));
  await client.query(`alter database ${escapeIdentifier(name)} with is_template true`);
}

function randomSuffix(): string {
  return randomBytes(6).toString("hex");
}

/**
 * Vitest globalSetup. Creates the migrated template for the current migrations once, holding an
 * exclusive advisory lock so parallel runs never race, and tags this run so its teardown can drop
 * any `t_*` database a crashed test file left behind.
 *
 * Use it from a package's globalSetup file: `export { setupTemplate as default } from
 * "@loomcast/db/testing";`
 */
export async function setupTemplate(): Promise<() => Promise<void>> {
  const runId = randomSuffix();
  process.env[RUN_ID_ENV] = runId;
  const template = templateDatabaseName();
  await withAdmin((client) =>
    withTemplateLock(client, "exclusive", () => ensureTemplate(client, template)),
  );

  return async () => {
    await withAdmin(async (client) => {
      const leftovers = await client.query<{ datname: string }>(
        "select datname from pg_database where starts_with(datname, $1)",
        [`${TEST_DB_PREFIX}${runId}_`],
      );
      for (const { datname } of leftovers.rows) {
        await dropDatabase(client, datname);
      }
    });
  };
}

export interface CreateTestDbOptions {
  /** Start from an empty database (`template0`) instead of the migrated template. */
  empty?: boolean;
  /** Most pooled connections. Defaults to 5. */
  max?: number;
}

export interface TestDb {
  db: Database;
  /** Connection string of the new database. */
  url: string;
  /** Database name, `t_<random>`. */
  name: string;
  /** Closes the pool and drops the database. Call it in `afterAll`. */
  drop: () => Promise<void>;
}

/**
 * Creates a fresh database `t_<random>` cloned from the migrated template (or empty) and returns a
 * Drizzle client for it. Requires `setupTemplate` to have run as the vitest globalSetup.
 */
export async function createTestDb(options: CreateTestDbOptions = {}): Promise<TestDb> {
  const runId = process.env[RUN_ID_ENV];
  const name = `${TEST_DB_PREFIX}${runId === undefined ? "" : `${runId}_`}${randomSuffix()}`;
  const template = options.empty === true ? "template0" : templateDatabaseName();

  await withAdmin(async (client) => {
    const create = () =>
      client.query(
        `create database ${escapeIdentifier(name)} template ${escapeIdentifier(template)}`,
      );
    if (options.empty === true) {
      await create();
      return;
    }
    await withTemplateLock(client, "shared", async () => {
      const found = await client.query("select 1 from pg_database where datname = $1", [template]);
      if (found.rowCount === 0) {
        throw new Error(
          `Template database ${template} does not exist. Register setupTemplate from ` +
            "@loomcast/db/testing as the vitest globalSetup.",
        );
      }
      await create();
    });
  });

  const url = databaseUrl(name);
  const { db, close } = createDb(url, { max: options.max ?? 5 });
  return {
    db,
    url,
    name,
    drop: async () => {
      await close();
      await withAdmin((client) => dropDatabase(client, name));
    },
  };
}
