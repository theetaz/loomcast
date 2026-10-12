export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export type LogFields = Readonly<Record<string, unknown>>;

/** A small structured logger. Lines go to stderr, which launchd writes to the agent's log file. */
export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** A logger that adds `fields` to every line. */
  child(fields: LogFields): Logger;
}

export interface LoggerOptions {
  readonly level?: LogLevel;
  readonly write?: (line: string) => void;
  readonly now?: () => Date;
}

export function createLogger(options: LoggerOptions = {}, bound: LogFields = {}): Logger {
  const minimum = LOG_LEVELS.indexOf(options.level ?? "info");
  const write = options.write ?? ((line: string) => process.stderr.write(line));
  const now = options.now ?? (() => new Date());

  const log =
    (level: LogLevel) =>
    (message: string, fields: LogFields = {}): void => {
      if (LOG_LEVELS.indexOf(level) < minimum) {
        return;
      }
      const merged = { ...bound, ...fields };
      const suffix = Object.keys(merged).length > 0 ? ` ${JSON.stringify(merged)}` : "";
      write(`${now().toISOString()} ${level.padEnd(5)} ${message}${suffix}\n`);
    };

  return {
    debug: log("debug"),
    info: log("info"),
    warn: log("warn"),
    error: log("error"),
    child: (fields) => createLogger(options, { ...bound, ...fields }),
  };
}

/** Discards everything. */
export const silentLogger: Logger = createLogger({ write: () => {} });

export function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}
