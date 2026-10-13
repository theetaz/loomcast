/**
 * The API under test, started by Playwright's `webServer`. It creates and migrates the scratch
 * database, runs the real API entry point (`apps/api/src/server.ts`) against it, and on SIGTERM or
 * SIGINT stops the API and drops the database.
 *
 * Playwright starts its web servers before the global setup runs, so the database has to exist
 * before the API starts; that is why it is created here.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { migrate } from "@loomcast/db";
import { Client, escapeIdentifier } from "pg";
import {
  apiEnvironment,
  DATABASE_PREFIX,
  e2eSettings,
  REPO_ROOT,
  STORAGE_KEYS,
  storageAvailable,
  storageEnvironment,
} from "./env.ts";

/** Scratch databases older than this are left over from an aborted run and are dropped. */
const STALE_AFTER_S = 6 * 60 * 60;

const settings = e2eSettings();

function log(message: string): void {
  process.stderr.write(`[e2e api] ${message}\n`);
}

async function withAdmin<T>(run: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: settings.adminUrl });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

async function dropDatabase(client: Client, name: string): Promise<void> {
  await client.query(`drop database if exists ${escapeIdentifier(name)} with (force)`);
}

async function createDatabase(): Promise<void> {
  await withAdmin(async (client) => {
    const existing = await client.query<{ datname: string }>(
      "select datname from pg_database where starts_with(datname, $1)",
      [DATABASE_PREFIX],
    );
    const now = Math.floor(Date.now() / 1000);
    for (const { datname } of existing.rows) {
      const created = Number(datname.slice(DATABASE_PREFIX.length).split("_")[0]);
      if (Number.isFinite(created) && now - created > STALE_AFTER_S) {
        log(`dropping stale database ${datname}`);
        await dropDatabase(client, datname);
      }
    }
    await client.query(`create database ${escapeIdentifier(settings.databaseName)}`);
  });
  await migrate(settings.databaseUrl);
  log(`database ${settings.databaseName} created and migrated`);
}

/**
 * The API's environment. With object storage (the local SeaweedFS, see `storageAvailable`) the
 * API presigns uploads to it; without, the S3 settings are removed so it starts without storage.
 */
async function environment(): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = { ...process.env, ...apiEnvironment(settings) };
  if (await storageAvailable()) {
    Object.assign(env, storageEnvironment());
    log(`object storage at ${env.S3_ENDPOINT}`);
  } else {
    for (const key of STORAGE_KEYS) delete env[key];
    log("no object storage: the pipeline spec is skipped");
  }
  return env;
}

function startApi(env: NodeJS.ProcessEnv): ChildProcess {
  const require = createRequire(join(REPO_ROOT, "apps/api/package.json"));
  const tsxCli = require.resolve("tsx/cli");
  return spawn(process.execPath, [tsxCli, "src/server.ts"], {
    cwd: join(REPO_ROOT, "apps/api"),
    env,
    stdio: ["ignore", "inherit", "inherit"],
  });
}

let api: ChildProcess | null = null;
let stopping: Promise<void> | null = null;

function stop(code: number): Promise<void> {
  stopping ??= (async () => {
    if (api !== null && api.exitCode === null && api.signalCode === null) {
      const exited = new Promise<void>((resolve) => api?.once("exit", () => resolve()));
      api.kill("SIGTERM");
      await exited;
    }
    try {
      await withAdmin((client) => dropDatabase(client, settings.databaseName));
      log(`database ${settings.databaseName} dropped`);
    } catch (error) {
      log(`could not drop ${settings.databaseName}: ${(error as Error).message}`);
    }
    process.exit(code);
  })();
  return stopping;
}

process.once("SIGTERM", () => void stop(0));
process.once("SIGINT", () => void stop(0));

let apiEnv: NodeJS.ProcessEnv = {};
try {
  await createDatabase();
  apiEnv = await environment();
} catch (error) {
  log(`could not prepare the API: ${(error as Error).message}`);
  await stop(1);
}

api = startApi(apiEnv);
api.once("exit", (code, signal) => {
  if (stopping === null) {
    log(`the API exited unexpectedly (code ${code}, signal ${signal})`);
    void stop(1);
  }
});
