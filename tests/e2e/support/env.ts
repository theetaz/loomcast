import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
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

/** The environment the API runs with: the scratch database and the web origin. */
export function apiEnvironment(settings: E2eSettings): Record<string, string> {
  return {
    NODE_ENV: "development",
    DATABASE_URL: settings.databaseUrl,
    APP_ORIGIN: settings.webUrl,
    API_PORT: String(settings.apiPort),
    API_HOST: "127.0.0.1",
    PUBLIC_BASE_URL: "https://media.example.test",
    LOG_LEVEL: process.env.LOOMCAST_E2E_LOG_LEVEL ?? "warn",
    TRUST_PROXY: "false",
  };
}
