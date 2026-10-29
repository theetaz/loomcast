import { join } from "node:path";

/** Where the CLI connects when nothing else is configured. */
export const DEFAULT_URL = "https://loomcast.prabhavalabs.com";

/** The token file, relative to the home directory. */
export const TOKEN_FILE = join(".config", "loomcast", "mcp.env");

/** Where the server and the tokens come from. Tokens are never printed. */
export interface Config {
  /** The server's origin, without `/mcp`. */
  url: string;
  /** The token used first. */
  token: string;
  /**
   * An owner token (`mcp:admin`) to retry with when a tool refuses `token` for lacking that scope.
   * Null when there is none, or when `token` already is it.
   */
  adminToken: string | null;
  /** Default workspace for the shortcuts (`LOOMCAST_WORKSPACE`), if any. */
  workspace: string | null;
}

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

/**
 * `KEY=value` lines of an env file. Blank lines and `#` comments are skipped, an `export ` prefix
 * is allowed, and one pair of surrounding quotes is removed.
 */
export function parseEnvFile(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (match === null) continue;
    const [, key = "", rawValue = ""] = match;
    let value = rawValue.trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function nonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? null : trimmed;
}

/**
 * Resolves the server and the tokens.
 *
 * - URL: `--url`, then `LOOMCAST_URL` in the environment, then in the token file, then
 *   `DEFAULT_URL`.
 * - Token: `LOOMCAST_TOKEN` in the environment wins. Otherwise the token file's
 *   `LOOMCAST_MCP_TOKEN`, or its `LOOMCAST_MCP_ADMIN_TOKEN` with `admin` (or when it is the only
 *   one). The admin token is kept for a retry when a tool needs `mcp:admin`.
 */
export function resolveConfig(input: {
  env: Record<string, string | undefined>;
  /** The token file's contents, or null when it does not exist. */
  file: string | null;
  url?: string | undefined;
  admin?: boolean | undefined;
}): Config {
  const file = input.file === null ? {} : parseEnvFile(input.file);
  const url = (
    nonEmpty(input.url) ??
    nonEmpty(input.env.LOOMCAST_URL) ??
    nonEmpty(file.LOOMCAST_URL) ??
    DEFAULT_URL
  ).replace(/\/+$/, "");
  if (!/^https?:\/\//.test(url)) {
    throw new ConfigError(`The server URL must start with http:// or https:// (got ${url}).`);
  }
  const workspace = nonEmpty(input.env.LOOMCAST_WORKSPACE) ?? nonEmpty(file.LOOMCAST_WORKSPACE);

  const envToken = nonEmpty(input.env.LOOMCAST_TOKEN);
  const fileToken = nonEmpty(file.LOOMCAST_MCP_TOKEN);
  const adminToken = nonEmpty(file.LOOMCAST_MCP_ADMIN_TOKEN);
  if (envToken !== null) {
    return { url, token: envToken, adminToken: null, workspace };
  }
  if (input.admin === true) {
    if (adminToken === null) {
      throw new ConfigError(
        `--admin needs LOOMCAST_MCP_ADMIN_TOKEN in ~/${TOKEN_FILE}, or an owner token in LOOMCAST_TOKEN.`,
      );
    }
    return { url, token: adminToken, adminToken: null, workspace };
  }
  if (fileToken !== null) {
    return { url, token: fileToken, adminToken, workspace };
  }
  if (adminToken !== null) {
    return { url, token: adminToken, adminToken: null, workspace };
  }
  throw new ConfigError(
    `No access token. Set LOOMCAST_TOKEN, or put LOOMCAST_MCP_TOKEN (and optionally ` +
      `LOOMCAST_MCP_ADMIN_TOKEN) in ~/${TOKEN_FILE}. Create tokens in the web app under ` +
      "Settings → Access tokens.",
  );
}
