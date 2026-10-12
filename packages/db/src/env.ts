import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT_ENV_FILE = fileURLToPath(new URL("../../../.env", import.meta.url));

/**
 * Loads the repository's root `.env` when it exists. Variables already set in the environment win,
 * so CI and production settings are never overridden by a local file.
 */
export function loadRootEnv(): void {
  if (existsSync(ROOT_ENV_FILE)) {
    process.loadEnvFile(ROOT_ENV_FILE);
  }
}

/** Returns a required environment variable, loading the root `.env` first. */
export function requireEnv(name: string): string {
  loadRootEnv();
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is not set. Copy .env.example to .env or export it.`);
  }
  return value;
}
