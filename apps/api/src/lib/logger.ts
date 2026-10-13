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
] as const;

function redactPaths(): string[] {
  const paths: string[] = [];
  for (const key of SENSITIVE_KEYS) {
    const segment = /^[A-Za-z_$][\w$]*$/.test(key) ? `.${key}` : `["${key}"]`;
    const bare = segment.startsWith(".") ? segment.slice(1) : segment;
    paths.push(bare, `*${segment}`, `*.*${segment}`, `*.*.*${segment}`);
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
