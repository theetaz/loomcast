import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type Credits,
  CreditsSchema,
  DeviceTokenSecretSchema,
  IdSchema,
  TOKEN_PREFIXES,
} from "@loomcast/contracts";
import { z } from "zod";
import type { AgentPaths } from "./paths";
import {
  ensurePrivateDir,
  isNotFound,
  PRIVATE_FILE_MODE,
  writePrivateFileAtomic,
} from "./private-fs";
import { normalizeServerUrl } from "./server-url";

/** Jobs run at the same time per concurrency class, unless the config says otherwise. */
export const DEFAULT_CONCURRENCY: Credits = { producer: 1, render: 1 };

/** `~/Loomcast`: producer sessions work in `<workspaceRoot>/projects/<projectId>`. */
export function defaultWorkspaceRoot(): string {
  return join(homedir(), "Loomcast");
}

export const AgentConfigSchema = z.object({
  serverUrl: z.string().transform((value, ctx) => {
    try {
      return normalizeServerUrl(value);
    } catch (error) {
      ctx.addIssue({ code: "custom", message: (error as Error).message });
      return z.NEVER;
    }
  }),
  deviceId: IdSchema,
  token: DeviceTokenSecretSchema,
  workspaceRoot: z.string().min(1),
  concurrency: CreditsSchema,
  /**
   * The `yt-dlp` binary that downloads public competitor videos: an absolute path, or a name
   * looked up on `PATH`. Defaults to `yt-dlp`.
   */
  ytDlpPath: z.string().min(1).max(1_000).optional(),
});
export type AgentConfig = z.output<typeof AgentConfigSchema>;

/** The config file exists but cannot be used. */
export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

/** Reads the config. Returns `null` when the agent has not been paired yet. */
export function loadConfig(paths: AgentPaths): AgentConfig | null {
  let text: string;
  try {
    text = readFileSync(paths.configFile, "utf8");
  } catch (error) {
    if (isNotFound(error)) {
      return null;
    }
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ConfigError(`${paths.configFile} is not valid JSON; pair the agent again`);
  }
  const result = AgentConfigSchema.safeParse(value);
  if (!result.success) {
    const fields = result.error.issues.map((issue) => issue.path.join(".") || "(root)");
    throw new ConfigError(
      `${paths.configFile} is invalid (${[...new Set(fields)].join(", ")}); pair the agent again`,
    );
  }
  return result.data;
}

/** Writes the config into a private directory (0700) as a private file (0600). */
export function saveConfig(paths: AgentPaths, config: AgentConfig): void {
  const valid = AgentConfigSchema.parse(config);
  ensurePrivateDir(paths.home);
  writePrivateFileAtomic(paths.configFile, `${JSON.stringify(valid, null, 2)}\n`);
}

/** Whether the config file can be read by other users, for example after a manual copy. */
export function configIsShared(paths: AgentPaths): boolean {
  return (statSync(paths.configFile).mode & 0o777 & ~PRIVATE_FILE_MODE) !== 0;
}

export const REDACTED_TOKEN = `${TOKEN_PREFIXES.device}[redacted]`;

/** The config with the device token replaced, safe to print or log. */
export function redactConfig(config: AgentConfig): Omit<AgentConfig, "token"> & { token: string } {
  return { ...config, token: REDACTED_TOKEN };
}

// Secrets the agent itself uses, such as the TTS provider key. They live in
// `<state dir>/secrets.env` (mode 0600, in the 0700 state directory), never in the config, a job
// payload, a result, the outbox, the journal or a log line.

/** The secrets the CLI can set, and the variable each is stored under. */
export const SECRET_NAMES = {
  "voice-provider-key": "LOOMCAST_VOICE_PROVIDER_KEY",
} as const;
export type SecretName = keyof typeof SECRET_NAMES;

export function isSecretName(value: string): value is SecretName {
  return Object.hasOwn(SECRET_NAMES, value);
}

/** `<state dir>/secrets.env`. */
export function secretsFile(paths: AgentPaths): string {
  return join(paths.home, "secrets.env");
}

/** A secret value: one line of printable characters without spaces, at most 1,000. */
const SecretValueSchema = z
  .string()
  .trim()
  .min(1, "The value is empty")
  .max(1_000, "The value is too long")
  .regex(/^[\x21-\x7e]+$/, "The value must be one line of printable characters without spaces");

function readSecrets(paths: AgentPaths): Map<string, string> {
  let text: string;
  try {
    text = readFileSync(secretsFile(paths), "utf8");
  } catch (error) {
    if (isNotFound(error)) {
      return new Map();
    }
    throw error;
  }
  const values = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (match?.[1] !== undefined && match[2] !== undefined && match[2].length > 0) {
      values.set(match[1], match[2]);
    }
  }
  return values;
}

function writeSecrets(paths: AgentPaths, values: ReadonlyMap<string, string>): void {
  ensurePrivateDir(paths.home);
  const lines = [...values].map(([name, value]) => `${name}=${value}`);
  writePrivateFileAtomic(secretsFile(paths), lines.length === 0 ? "" : `${lines.join("\n")}\n`);
}

/** Stores a secret in the private secrets file. Throws when the value is not usable. */
export function setSecret(paths: AgentPaths, name: SecretName, value: string): void {
  const parsed = SecretValueSchema.safeParse(value);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues[0]?.message ?? "The value is not usable");
  }
  const values = readSecrets(paths);
  values.set(SECRET_NAMES[name], parsed.data);
  writeSecrets(paths, values);
}

/** Removes a secret. Returns false when it was not set. */
export function unsetSecret(paths: AgentPaths, name: SecretName): boolean {
  const values = readSecrets(paths);
  if (!values.delete(SECRET_NAMES[name])) {
    return false;
  }
  writeSecrets(paths, values);
  return true;
}

/** Reads a secret, or undefined when it is not set. */
export function readSecret(paths: AgentPaths, name: SecretName): string | undefined {
  return readSecrets(paths).get(SECRET_NAMES[name]);
}
