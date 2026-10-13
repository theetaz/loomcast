import pino, { type DestinationStream, type Logger } from "pino";
import type { LogLevel } from "../env";

export type { Logger } from "pino";

/**
 * Keys whose values never reach a log line, at any of the first four nesting levels. Request
 * logging never includes headers or bodies; this is the safety net for code that logs an object
 * carelessly.
 */
const SENSITIVE_KEYS = [
  "authorization",
  "cookie",
  "set-cookie",
  "password",
  "currentPassword",
  "newPassword",
  "passwordHash",
  "token",
  "secret",
  // Set-password links carry their secret in the URL fragment.
  "setPasswordUrl",
  // Job credentials in `job.assign` hold a job token.
  "credentials",
  // Object storage keys (`config.storage`).
  "secretAccessKey",
  // Token vault keys (`config.encryption`) and the settings they come from.
  "encryption",
  "LOOMCAST_ENCRYPTION_KEY",
  "LOOMCAST_ENCRYPTION_KEYS_PREVIOUS",
  // Sealed channel credentials (`channels.secret_*`).
  "secretCiphertext",
  "secretNonce",
  // The alert webhook (`config.alerts.webhookUrl`) carries its secret in the URL.
  "webhookUrl",
  "ALERT_WEBHOOK_URL",
  // Platform app secrets (`config.platforms`) and the settings they come from.
  "appSecret",
  "META_APP_SECRET",
  "THREADS_APP_SECRET",
  // Platform credentials, in the field names of the OAuth and Graph API requests.
  "accessToken",
  "access_token",
  "refresh_token",
  "client_secret",
  "appsecret_proof",
  "fb_exchange_token",
  "input_token",
] as const;

/**
 * Keys that are credentials only under these parents: an OAuth `code` in a callback query is one,
 * but the `code` of an error is not, so `code` is not redacted everywhere.
 */
const SENSITIVE_NESTED_PATHS = ["query.code", "params.code", "callback.code"] as const;

function redactPaths(): string[] {
  const paths: string[] = [];
  for (const key of SENSITIVE_KEYS) {
    const segment = /^[A-Za-z_$][\w$]*$/.test(key) ? `.${key}` : `["${key}"]`;
    const bare = segment.startsWith(".") ? segment.slice(1) : segment;
    paths.push(bare, `*${segment}`, `*.*${segment}`, `*.*.*${segment}`);
  }
  for (const path of SENSITIVE_NESTED_PATHS) {
    paths.push(path, `*.${path}`, `*.*.${path}`);
  }
  return paths;
}

export const REDACT_PATHS: readonly string[] = redactPaths();

export interface LoggerOptions {
  level: LogLevel;
  /** Defaults to stdout. Tests pass a stream to capture lines. */
  destination?: DestinationStream;
}

/** The root logger: JSON lines, with credentials redacted. */
export function createLogger(options: LoggerOptions): Logger {
  return pino(
    {
      level: options.level,
      base: { service: "api" },
      redact: { paths: [...REDACT_PATHS], censor: "[redacted]" },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    options.destination,
  );
}
