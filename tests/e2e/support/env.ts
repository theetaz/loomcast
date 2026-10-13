import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The repository root. */
export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

const ROOT_ENV_FILE = fileURLToPath(new URL("../../../.env", import.meta.url));

/** Prefix of the scratch databases the smoke creates; nothing else uses it. */
export const DATABASE_PREFIX = "loomcast_e2e_";

/** Settings shared by the Playwright config, the servers, the global setup and the specs. */
export interface E2eSettings {
  /** Port of the API under test. */
  apiPort: number;
  /** Port of the Vite dev server under test. */
  webPort: number;
  /** `http://127.0.0.1:<apiPort>`. */
  apiUrl: string;
  /** `http://127.0.0.1:<webPort>`: the app origin the browser, the agent and MCP use. */
  webUrl: string;
  /** Admin connection used to create and drop the scratch database. */
  adminUrl: string;
  /** Scratch database name: `loomcast_e2e_<unix seconds>_<random>`. */
  databaseName: string;
  /** Connection string of the scratch database. */
  databaseUrl: string;
  ownerEmail: string;
  ownerName: string;
  /** Generated for each run; never stored anywhere but this process tree's environment. */
  ownerPassword: string;
}

const KEYS = {
  apiPort: "LOOMCAST_E2E_API_PORT",
  webPort: "LOOMCAST_E2E_WEB_PORT",
  databaseName: "LOOMCAST_E2E_DATABASE",
  ownerEmail: "LOOMCAST_E2E_OWNER_EMAIL",
  ownerPassword: "LOOMCAST_E2E_OWNER_PASSWORD",
} as const;

/**
 * Two free loopback ports. Playwright reads its config synchronously, so a short child process
 * asks the OS for them.
 */
function freePorts(): [number, number] {
  const script = [
    "const net = require('node:net');",
    "const open = () => new Promise((resolve) => {",
    "  const server = net.createServer();",
    "  server.listen(0, '127.0.0.1', () => resolve(server));",
    "});",
    "Promise.all([open(), open()]).then((servers) => {",
    "  process.stdout.write(servers.map((s) => s.address().port).join(' '));",
    "  for (const s of servers) s.close();",
    "});",
  ].join("\n");
  const output = execFileSync(process.execPath, ["-e", script], { encoding: "utf8" });
  const [api, web] = output.trim().split(" ").map(Number);
  if (!api || !web) {
    throw new Error(`could not find free ports (got "${output}")`);
  }
  return [api, web];
}

function adminConnectionUrl(): string {
  if (process.env.TEST_DATABASE_ADMIN_URL === undefined && existsSync(ROOT_ENV_FILE)) {
    process.loadEnvFile(ROOT_ENV_FILE);
  }
  const url = process.env.TEST_DATABASE_ADMIN_URL;
  if (url === undefined || url === "") {
    throw new Error(
      "TEST_DATABASE_ADMIN_URL is not set. Export it (a role that may create databases, " +
        "connected to the postgres database) or copy .env.example to .env.",
    );
  }
  return url;
}

/**
 * The settings of this run. The first call (in the Playwright runner) picks free ports, a scratch
 * database name and owner credentials and stores them in `process.env`; the web servers, the
 * global setup and the test workers inherit that environment, so every later call agrees.
 */
/** A random value generated per run; the suite never holds a fixed credential. */
function generatedSecret(): string {
  return randomBytes(24).toString("base64url");
}

export function e2eSettings(): E2eSettings {
  const env = process.env;
  if (env[KEYS.databaseName] === undefined) {
    const [apiPort, webPort] = freePorts();
    env[KEYS.apiPort] = String(apiPort);
    env[KEYS.webPort] = String(webPort);
    env[KEYS.databaseName] =
      `${DATABASE_PREFIX}${Math.floor(Date.now() / 1000)}_${randomBytes(4).toString("hex")}`;
    env[KEYS.ownerEmail] = `owner-${randomBytes(4).toString("hex")}@example.test`;
    env[KEYS.ownerPassword] = generatedSecret();
  }
  const apiPort = Number(env[KEYS.apiPort]);
  const webPort = Number(env[KEYS.webPort]);
  const databaseName = env[KEYS.databaseName] ?? "";
  const adminUrl = adminConnectionUrl();
  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${databaseName}`;
  return {
    apiPort,
    webPort,
    apiUrl: `http://127.0.0.1:${apiPort}`,
    webUrl: `http://127.0.0.1:${webPort}`,
    adminUrl,
    databaseName,
    databaseUrl: databaseUrl.toString(),
    ownerEmail: env[KEYS.ownerEmail] ?? "",
    ownerName: "E2E Owner",
    ownerPassword: env[KEYS.ownerPassword] ?? "",
  };
}

/**
 * Whether the run uses object storage, from `LOOMCAST_E2E_S3`:
 * - `auto` (default): the local SeaweedFS when it answers, otherwise the pipeline spec is skipped;
 * - `required`: the store must answer (CI sets this), otherwise the run fails;
 * - `off`: the API runs without storage and the pipeline spec is skipped.
 */
export type StorageMode = "auto" | "required" | "off";

export function storageMode(): StorageMode {
  const value = process.env.LOOMCAST_E2E_S3 ?? "auto";
  if (value === "auto" || value === "required" || value === "off") {
    return value;
  }
  throw new Error(`LOOMCAST_E2E_S3 must be auto, required or off (got "${value}")`);
}

const SEAWEEDFS_CONFIG = fileURLToPath(
  new URL("../../../infra/seaweedfs/s3.json", import.meta.url),
);

/**
 * The keys of the local store: `S3_ACCESS_KEY` and `S3_SECRET_KEY` when set, otherwise the
 * development identity in `infra/seaweedfs/s3.json` (the file the local stack and CI start the
 * store with), so the suite never holds a key of its own.
 */
function storageKeys(): { accessKey: string; secretKey: string } {
  const accessKey = process.env.S3_ACCESS_KEY;
  const secretKey = process.env.S3_SECRET_KEY;
  if (accessKey && secretKey) {
    return { accessKey, secretKey };
  }
  const config = JSON.parse(readFileSync(SEAWEEDFS_CONFIG, "utf8")) as {
    identities: { credentials?: { accessKey: string; secretKey: string }[] }[];
  };
  const credentials = config.identities.find((identity) => identity.credentials?.length)
    ?.credentials?.[0];
  if (credentials === undefined) {
    throw new Error(`no S3 credentials in ${SEAWEEDFS_CONFIG}`);
  }
  return credentials;
}

/** The S3 endpoint of the run: `S3_ENDPOINT`, or the local SeaweedFS. */
export function storageEndpoint(): string {
  return process.env.S3_ENDPOINT || "http://127.0.0.1:59000";
}

/** True when something answers HTTP at the store's endpoint within a second and a half. */
async function storageReachable(endpoint: string): Promise<boolean> {
  try {
    const response = await fetch(`${endpoint}/`, { signal: AbortSignal.timeout(1_500) });
    await response.body?.cancel();
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether this run has object storage. In `required` mode an unreachable store is an error; in
 * `auto` mode it means no storage.
 */
export async function storageAvailable(): Promise<boolean> {
  const mode = storageMode();
  if (mode === "off") {
    return false;
  }
  const reachable = await storageReachable(storageEndpoint());
  if (!reachable && mode === "required") {
    throw new Error(
      `LOOMCAST_E2E_S3=required but nothing answers at ${storageEndpoint()}. Start the object ` +
        "store (docker compose up -d s3 s3-init) or unset LOOMCAST_E2E_S3.",
    );
  }
  return reachable;
}

/** The API's object storage settings for the local store, with the media buckets of the stack. */
export function storageEnvironment(): Record<string, string> {
  const { accessKey, secretKey } = storageKeys();
  return {
    S3_ENDPOINT: storageEndpoint(),
    S3_REGION: process.env.S3_REGION || "auto",
    S3_FORCE_PATH_STYLE: "true",
    S3_BUCKET: process.env.S3_BUCKET || "loomcast-media",
    S3_PUBLIC_BUCKET: process.env.S3_PUBLIC_BUCKET || "loomcast-public",
    S3_ACCESS_KEY: accessKey,
    S3_SECRET_KEY: secretKey,
  };
}

/** The S3 settings the API must not inherit when the run has no storage. */
export const STORAGE_KEYS = ["S3_ENDPOINT", "S3_ACCESS_KEY", "S3_SECRET_KEY"] as const;

/** How often the API's scheduler looks for due tasks in the suite, so slots are met promptly. */
export const SCHEDULER_TICK_MS = 500;

/** How far ahead the cadence planner fills the calendar in the suite (the server default). */
export const CADENCE_HORIZON_DAYS = 14;

/**
 * The environment the API runs with: the scratch database, the web origin, a fast scheduler tick
 * and dry-run publishing (whatever `.env` says), so nothing is ever sent to a platform.
 */
export function apiEnvironment(settings: E2eSettings): Record<string, string> {
  return {
    NODE_ENV: "development",
    SCHEDULER_ENABLED: "true",
    SCHEDULER_TICK_MS: String(SCHEDULER_TICK_MS),
    PUBLISHING_MODE: "dry-run",
    PUBLISHING_ENABLED: "true",
    CADENCE_HORIZON_DAYS: String(CADENCE_HORIZON_DAYS),
    DATABASE_URL: settings.databaseUrl,
    APP_ORIGIN: settings.webUrl,
    API_PORT: String(settings.apiPort),
    API_HOST: "127.0.0.1",
    PUBLIC_BASE_URL: "https://media.example.test",
    LOG_LEVEL: process.env.LOOMCAST_E2E_LOG_LEVEL ?? "warn",
    TRUST_PROXY: "false",
  };
}
