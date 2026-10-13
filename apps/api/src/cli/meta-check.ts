import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ConfigError, loadRootEnv, type MetaCheckConfig, parseMetaCheckConfig } from "../env";
import {
  createMetaGraphClient,
  createThreadsGraphClient,
  type FetchLike,
  getMetaApp,
  MetaGraphError,
  metaAppAccessToken,
  threadsAppAccessToken,
} from "../lib/meta-graph";
import { oauthRedirectUri } from "../modules/oauth/redirect";

const USAGE = `Usage:
  meta-check

Checks the Meta and Threads app credentials of this server: asks for an app access token
with META_APP_ID and META_APP_SECRET and reads the app's record, then asks for one with
THREADS_APP_ID and THREADS_APP_SECRET. Prints the Graph API version and the redirect URIs to
register with the apps. Never prints a secret or a token.

Exit codes: 0 when every configured app passed, 1 when a check failed or nothing is
configured, 2 for a usage error.

Reads the settings from the environment or the repository's .env (outside production).`;

export interface MetaCheckIo {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

export interface MetaCheckOptions {
  /** Defaults to the global `fetch`; tests answer with synthetic responses. */
  fetch?: FetchLike;
}

function describeFailure(error: unknown): string {
  if (error instanceof MetaGraphError) {
    const code = error.error.platformCode === undefined ? "" : ` (${error.error.platformCode})`;
    return `${error.error.code}${code}: ${error.error.message}`;
  }
  return "the request failed unexpectedly";
}

async function checkMeta(
  config: MetaCheckConfig,
  io: MetaCheckIo,
  fetch: FetchLike | undefined,
): Promise<boolean> {
  const app = config.meta;
  if (app === null) {
    io.stdout.write("Meta: not configured (META_APP_ID, META_APP_SECRET, META_LOGIN_CONFIG_ID).\n");
    return true;
  }
  const client = createMetaGraphClient(config, fetch === undefined ? {} : { fetch });
  try {
    const appToken = await metaAppAccessToken(client, app);
    const record = await getMetaApp(client, { appId: app.appId, accessToken: appToken });
    if (record.id !== app.appId) {
      io.stderr.write("Meta: FAILED, the app token belongs to another app.\n");
      return false;
    }
    io.stdout.write(
      `Meta: OK, app ${record.id}${record.name === undefined ? "" : ` (${record.name})`}, ` +
        `Graph API ${config.metaGraphVersion}, login configuration ${app.loginConfigId}.\n`,
    );
    return true;
  } catch (error) {
    io.stderr.write(`Meta: FAILED, ${describeFailure(error)}\n`);
    return false;
  }
}

async function checkThreads(
  config: MetaCheckConfig,
  io: MetaCheckIo,
  fetch: FetchLike | undefined,
): Promise<boolean> {
  const app = config.threads;
  if (app === null) {
    io.stdout.write("Threads: not configured (THREADS_APP_ID, THREADS_APP_SECRET).\n");
    return true;
  }
  const client = createThreadsGraphClient(config, fetch === undefined ? {} : { fetch });
  try {
    await threadsAppAccessToken(client, app);
    io.stdout.write(`Threads: OK, app ${app.appId}.\n`);
    return true;
  } catch (error) {
    io.stderr.write(`Threads: FAILED, ${describeFailure(error)}\n`);
    return false;
  }
}

/** Runs the check. Returns the exit code. */
export async function runMetaCheck(
  argv: readonly string[],
  io: MetaCheckIo,
  env: Record<string, string | undefined>,
  options: MetaCheckOptions = {},
): Promise<number> {
  try {
    const { values, positionals } = parseArgs({
      args: argv.filter((arg) => arg !== "--"),
      allowPositionals: true,
      strict: true,
      options: { help: { type: "boolean", short: "h" } },
    });
    if (values.help === true) {
      io.stdout.write(`${USAGE}\n`);
      return 0;
    }
    if (positionals.length > 0) {
      throw new Error(`Unknown argument: ${positionals.join(" ")}`);
    }
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}\n`);
    return 2;
  }

  let config: MetaCheckConfig;
  try {
    config = parseMetaCheckConfig(env);
  } catch (error) {
    io.stderr.write(`${error instanceof ConfigError ? error.message : String(error)}\n`);
    return 1;
  }
  if (config.meta === null && config.threads === null) {
    io.stderr.write(
      "Neither the Meta app nor the Threads app is configured. See docs/runbooks/meta-app-setup.md.\n",
    );
    return 1;
  }

  const metaOk = await checkMeta(config, io, options.fetch);
  const threadsOk = await checkThreads(config, io, options.fetch);

  if (config.redirectBase === null) {
    io.stdout.write("Redirect URIs: set APP_ORIGIN or OAUTH_REDIRECT_BASE to print them.\n");
  } else {
    io.stdout.write("Redirect URIs to register:\n");
    if (config.meta !== null) {
      io.stdout.write(`  Facebook Login: ${oauthRedirectUri(config.redirectBase, "meta")}\n`);
    }
    if (config.threads !== null) {
      io.stdout.write(`  Threads:        ${oauthRedirectUri(config.redirectBase, "threads")}\n`);
    }
  }
  return metaOk && threadsOk ? 0 : 1;
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && realpathSync(entry) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  loadRootEnv();
  runMetaCheck(process.argv.slice(2), process, process.env).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : "meta-check failed");
      process.exitCode = 1;
    },
  );
}
