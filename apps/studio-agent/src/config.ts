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
