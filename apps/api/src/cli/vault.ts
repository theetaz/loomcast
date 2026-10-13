import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createDb } from "@loomcast/db";
import { ConfigError, loadRootEnv, parseVaultCliConfig } from "../env";
import { createVault, rotateVault, VaultError } from "../lib/vault";
import type { CliDatabase } from "./admin";

const USAGE = `Usage:
  vault rotate [--dry-run]

rotate   Seals every stored channel credential again with the current key
         (LOOMCAST_ENCRYPTION_KEY, version LOOMCAST_ENCRYPTION_KEY_VERSION), in one transaction.
         Values sealed with an earlier key are opened with LOOMCAST_ENCRYPTION_KEYS_PREVIOUS
         (version:key pairs). Refuses when a row uses a key version that is not configured.
--dry-run  Decrypts every value and reports what would change, without writing.

Reads DATABASE_URL and the LOOMCAST_ENCRYPTION_* settings from the environment or the
repository's .env (outside production).`;

export interface VaultCliIo {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

/**
 * Runs one vault command. Returns the exit code: 0 on success, 1 when the command was refused or
 * failed, 2 for a usage error. Key material is never printed.
 */
export async function runVault(
  argv: readonly string[],
  io: VaultCliIo,
  env: Record<string, string | undefined>,
  openDb: (databaseUrl: string) => CliDatabase,
): Promise<number> {
  let dryRun: boolean;
  try {
    const { values, positionals } = parseArgs({
      // `pnpm run vault:rotate -- --dry-run` may pass the separator through.
      args: argv.filter((arg) => arg !== "--"),
      allowPositionals: true,
      strict: true,
      options: { "dry-run": { type: "boolean" }, help: { type: "boolean", short: "h" } },
    });
    const [command, ...rest] = positionals;
    if (values.help === true || command === undefined || command === "help") {
      io.stdout.write(`${USAGE}\n`);
      return 0;
    }
    if (command !== "rotate" || rest.length > 0) {
      throw new Error(`Unknown command: ${positionals.join(" ")}`);
    }
    dryRun = values["dry-run"] === true;
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}\n`);
    return 2;
  }

  let database: CliDatabase | null = null;
  try {
    const config = parseVaultCliConfig(env);
    if (config.encryption === null) {
      io.stderr.write("LOOMCAST_ENCRYPTION_KEY is not set.\n");
      return 1;
    }
    const vault = createVault(config.encryption);
    database = openDb(config.databaseUrl);
    const result = await rotateVault(database.db, vault, { dryRun });
    const versions = Object.entries(result.byKeyVersion)
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([version, rows]) => `v${version}: ${rows}`)
      .join(", ");
    io.stdout.write(
      `${dryRun ? "Dry run: " : ""}${result.rows} sealed value(s) found` +
        `${versions === "" ? "" : ` (${versions})`}; current key version ${vault.keyVersion}.\n`,
    );
    io.stdout.write(
      dryRun
        ? `Every value decrypts. A rotation would seal ${result.rows} value(s) again.\n`
        : `Sealed ${result.reencrypted} value(s) again with key version ${vault.keyVersion}.\n`,
    );
    return 0;
  } catch (error) {
    if (error instanceof ConfigError || error instanceof VaultError) {
      io.stderr.write(`${error.message}\n`);
      return 1;
    }
    io.stderr.write(`Failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    await database?.close();
  }
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && realpathSync(entry) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  loadRootEnv();
  runVault(process.argv.slice(2), process, process.env, (databaseUrl) =>
    createDb(databaseUrl, { max: 2 }),
  ).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}
