import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type PublishingMode, PublishingModeSchema } from "@loomcast/contracts";
import { z } from "zod";
import type { StorageConfig } from "./lib/storage/types";
import { decodeVaultKey, parsePreviousVaultKeys, type VaultKeyring } from "./lib/vault";

const ROOT_ENV_FILE = fileURLToPath(new URL("../../../.env", import.meta.url));

/**
 * Loads the repository's root `.env` in development. Variables already set in the environment win,
 * so CI and production settings are never overridden by a local file.
 */
export function loadRootEnv(): void {
  if (process.env.NODE_ENV !== "production" && existsSync(ROOT_ENV_FILE)) {
    process.loadEnvFile(ROOT_ENV_FILE);
  }
}

const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const NODE_ENVS = ["development", "test", "production"] as const;
export type NodeEnv = (typeof NODE_ENVS)[number];

const PostgresUrlSchema = z
  .string()
  .min(1)
  .refine((value) => /^postgres(ql)?:\/\//.test(value), {
    message: "Expected a postgres:// connection string",
  });

const MiB = 1024 * 1024;

/** Largest upload `assets.finalize` hashes itself when the store did not record its SHA-256. */
export const DEFAULT_ASSET_VERIFY_MAX_BYTES = 512 * MiB;

/** An origin such as `https://loomcast.example.com`, without a path or trailing slash. */
const OriginSchema = z.url({ protocol: /^https?$/ }).transform((value) => new URL(value).origin);

/** Object storage settings that have no default: all set, or (outside production) all unset. */
const STORAGE_KEYS = ["S3_ENDPOINT", "S3_ACCESS_KEY", "S3_SECRET_KEY"] as const;

/** Default pause between scheduler ticks. */
export const DEFAULT_SCHEDULER_TICK_MS = 5_000;

/** Default number of days ahead the cadence planner fills with slots. */
export const DEFAULT_CADENCE_HORIZON_DAYS = 14;

/** An optional setting where an empty value (`KEY=` in an env file) counts as unset. */
const optionalText = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().optional(),
);

const ENCRYPTION_KEY_MESSAGE =
  "Must be 32 random bytes, base64 encoded (for example `openssl rand -base64 32`)";

const NodeEnvSchema = z.enum(NODE_ENVS).default("development");

const EncryptionEnvShape = {
  /**
   * Key of the token vault that encrypts channel credentials: 32 random bytes, base64 encoded.
   * Required in production; elsewhere it may be left out, and storing credentials answers 503.
   */
  LOOMCAST_ENCRYPTION_KEY: optionalText,
  /** Version stored with every value the current key seals. Raise it with each new key. */
  LOOMCAST_ENCRYPTION_KEY_VERSION: z.coerce.number().int().min(1).max(1_000_000).default(1),
  /** Earlier keys during a rotation: `version:base64key` pairs separated by commas. */
  LOOMCAST_ENCRYPTION_KEYS_PREVIOUS: optionalText,
};

interface EncryptionEnv {
  NODE_ENV: NodeEnv;
  LOOMCAST_ENCRYPTION_KEY?: string | undefined;
  LOOMCAST_ENCRYPTION_KEY_VERSION: number;
  LOOMCAST_ENCRYPTION_KEYS_PREVIOUS?: string | undefined;
}

/**
 * Checks the vault keys: a 32-byte key (required in production), previous keys that parse and do
 * not reuse the current version. Messages never include key material.
 */
function refineEncryption(env: EncryptionEnv, ctx: z.RefinementCtx): void {
  if (env.LOOMCAST_ENCRYPTION_KEY === undefined) {
    if (env.NODE_ENV === "production") {
      ctx.addIssue({
        code: "custom",
        path: ["LOOMCAST_ENCRYPTION_KEY"],
        message: `Required in production. ${ENCRYPTION_KEY_MESSAGE}`,
      });
    }
    if (env.LOOMCAST_ENCRYPTION_KEYS_PREVIOUS !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["LOOMCAST_ENCRYPTION_KEYS_PREVIOUS"],
        message: "Set LOOMCAST_ENCRYPTION_KEY as well",
      });
    }
  } else if (decodeVaultKey(env.LOOMCAST_ENCRYPTION_KEY) === null) {
    ctx.addIssue({
      code: "custom",
      path: ["LOOMCAST_ENCRYPTION_KEY"],
      message: ENCRYPTION_KEY_MESSAGE,
    });
  }
  if (
    env.LOOMCAST_ENCRYPTION_KEY !== undefined &&
    env.LOOMCAST_ENCRYPTION_KEYS_PREVIOUS !== undefined
  ) {
    const { keys, issues } = parsePreviousVaultKeys(env.LOOMCAST_ENCRYPTION_KEYS_PREVIOUS);
    if (keys.has(env.LOOMCAST_ENCRYPTION_KEY_VERSION)) {
      issues.push(
        `version ${env.LOOMCAST_ENCRYPTION_KEY_VERSION} is the current LOOMCAST_ENCRYPTION_KEY_VERSION`,
      );
    }
    for (const issue of issues) {
      ctx.addIssue({ code: "custom", path: ["LOOMCAST_ENCRYPTION_KEYS_PREVIOUS"], message: issue });
    }
  }
}

const EnvSchema = z
  .object({
    DATABASE_URL: PostgresUrlSchema,
    APP_ORIGIN: OriginSchema,
    API_PORT: z.coerce.number().int().min(0).max(65_535).default(8790),
    /** Interface to bind. Defaults to loopback, or all interfaces in production (inside a container). */
    API_HOST: z.string().min(1).optional(),
    NODE_ENV: NodeEnvSchema,
    LOG_LEVEL: z.enum(LOG_LEVELS).default("info"),
    PUBLIC_BASE_URL: z.url({ protocol: /^https?$/ }),
    /** Built web app to serve in production, with an SPA fallback to `index.html`. */
    WEB_DIST_DIR: z.string().min(1).optional(),
    /**
     * Set when a reverse proxy in front of the API appends the client address to `X-Forwarded-For`.
     * Without it, rate limits key on the socket address.
     */
    TRUST_PROXY: z.stringbool().default(false),
    /**
     * S3 API endpoint: Cloudflare R2 in production, SeaweedFS locally. With the two keys, required
     * in production; elsewhere all three may be left out, and the endpoints that need object storage
     * answer 503.
     */
    S3_ENDPOINT: z.url({ protocol: /^https?$/ }).optional(),
    /** Signing region; R2 expects `auto`. */
    S3_REGION: z.string().min(1).default("auto"),
    /** Path-style URLs (`<endpoint>/<bucket>/<key>`). R2 and SeaweedFS both accept them. */
    S3_FORCE_PATH_STYLE: z.stringbool().default(true),
    /** Private bucket for every upload. */
    S3_BUCKET: z.string().min(3).max(63).default("loomcast-media"),
    /** Public-read bucket served at `PUBLIC_BASE_URL`; only promoted final renders go there. */
    S3_PUBLIC_BUCKET: z.string().min(3).max(63).default("loomcast-public"),
    S3_ACCESS_KEY: z.string().min(1).optional(),
    S3_SECRET_KEY: z.string().min(1).optional(),
    /** Largest upload finalize hashes itself when the store did not record its SHA-256. */
    ASSET_VERIFY_MAX_BYTES: z.coerce.number().int().min(0).default(DEFAULT_ASSET_VERIFY_MAX_BYTES),
    ...EncryptionEnvShape,
    /** Runs the background task loop. Admin endpoints and enqueueing work either way. */
    SCHEDULER_ENABLED: z.stringbool().default(true),
    /** Pause between two claims of due tasks. */
    SCHEDULER_TICK_MS: z.coerce
      .number()
      .int()
      .min(100)
      .max(600_000)
      .default(DEFAULT_SCHEDULER_TICK_MS),
    /** `dry-run` records what would be posted without calling the platforms; `live` posts. */
    PUBLISHING_MODE: PublishingModeSchema.default("dry-run"),
    /** False pauses publishing entirely: due posts wait and retry later. */
    PUBLISHING_ENABLED: z.stringbool().default(true),
    /** How many days ahead the cadence planner creates slots. */
    CADENCE_HORIZON_DAYS: z.coerce
      .number()
      .int()
      .min(1)
      .max(90)
      .default(DEFAULT_CADENCE_HORIZON_DAYS),
  })
  .superRefine(refineEncryption)
  .superRefine((env, ctx) => {
    const missing = STORAGE_KEYS.filter((key) => env[key] === undefined);
    const allMissing = missing.length === STORAGE_KEYS.length;
    if (missing.length === 0 || (allMissing && env.NODE_ENV !== "production")) {
      return;
    }
    for (const key of missing) {
      ctx.addIssue({
        code: "custom",
        path: [key],
        message:
          env.NODE_ENV === "production"
            ? "Required in production"
            : "Set S3_ENDPOINT, S3_ACCESS_KEY and S3_SECRET_KEY together",
      });
    }
  });

export interface Config {
  databaseUrl: string;
  appOrigin: string;
  port: number;
  host: string;
  nodeEnv: NodeEnv;
  isProduction: boolean;
  logLevel: LogLevel;
  publicBaseUrl: string;
  /** Absolute path, or null when the API does not serve the web app. */
  webDistDir: string | null;
  trustProxy: boolean;
  /**
   * Object storage; `publicBaseUrl` is repeated there as the public bucket's base URL. Null when
   * no S3 settings are given outside production.
   */
  storage: StorageConfig | null;
  /** Largest upload `assets.finalize` hashes itself when the store did not record its SHA-256. */
  assetVerifyMaxBytes: number;
  /**
   * Keys of the token vault. Null when `LOOMCAST_ENCRYPTION_KEY` is not set outside production.
   * Holds key material: never log it.
   */
  encryption: VaultKeyring | null;
  scheduler: SchedulerConfig;
  publishing: PublishingConfig;
  /** How many days ahead the cadence planner creates slots. */
  cadenceHorizonDays: number;
}

export interface SchedulerConfig {
  /** Runs the background task loop under `startServer`. */
  enabled: boolean;
  /** Pause between two claims of due tasks. */
  tickMs: number;
}

export interface PublishingConfig {
  /** `PUBLISHING_MODE`: in `dry-run`, nothing is sent to a platform. */
  mode: PublishingMode;
  /** `PUBLISHING_ENABLED`: false pauses publishing. */
  enabled: boolean;
}

export class ConfigError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid environment:\n${issues.map((issue) => `  - ${issue}`).join("\n")}`);
    this.name = "ConfigError";
  }
}

/** Validates the environment and turns it into a `Config`. Throws `ConfigError` listing each issue. */
export function parseConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => `${issue.path.join(".") || "env"}: ${issue.message}`),
    );
  }
  const values = parsed.data;
  const isProduction = values.NODE_ENV === "production";
  const webDistDir =
    values.WEB_DIST_DIR === undefined
      ? null
      : isAbsolute(values.WEB_DIST_DIR)
        ? values.WEB_DIST_DIR
        : resolve(values.WEB_DIST_DIR);
  return {
    databaseUrl: values.DATABASE_URL,
    appOrigin: values.APP_ORIGIN,
    port: values.API_PORT,
    host: values.API_HOST ?? (isProduction ? "0.0.0.0" : "127.0.0.1"),
    nodeEnv: values.NODE_ENV,
    isProduction,
    logLevel: values.LOG_LEVEL,
    publicBaseUrl: values.PUBLIC_BASE_URL,
    webDistDir,
    trustProxy: values.TRUST_PROXY,
    storage:
      values.S3_ENDPOINT === undefined ||
      values.S3_ACCESS_KEY === undefined ||
      values.S3_SECRET_KEY === undefined
        ? null
        : {
            endpoint: values.S3_ENDPOINT,
            region: values.S3_REGION,
            forcePathStyle: values.S3_FORCE_PATH_STYLE,
            bucket: values.S3_BUCKET,
            publicBucket: values.S3_PUBLIC_BUCKET,
            accessKeyId: values.S3_ACCESS_KEY,
            secretAccessKey: values.S3_SECRET_KEY,
            publicBaseUrl: values.PUBLIC_BASE_URL,
          },
    assetVerifyMaxBytes: values.ASSET_VERIFY_MAX_BYTES,
    encryption: encryptionConfig(values),
    scheduler: { enabled: values.SCHEDULER_ENABLED, tickMs: values.SCHEDULER_TICK_MS },
    publishing: { mode: values.PUBLISHING_MODE, enabled: values.PUBLISHING_ENABLED },
    cadenceHorizonDays: values.CADENCE_HORIZON_DAYS,
  };
}

/** The vault keyring from validated settings; null without `LOOMCAST_ENCRYPTION_KEY`. */
function encryptionConfig(values: {
  LOOMCAST_ENCRYPTION_KEY?: string | undefined;
  LOOMCAST_ENCRYPTION_KEY_VERSION: number;
  LOOMCAST_ENCRYPTION_KEYS_PREVIOUS?: string | undefined;
}): VaultKeyring | null {
  const key =
    values.LOOMCAST_ENCRYPTION_KEY === undefined
      ? null
      : decodeVaultKey(values.LOOMCAST_ENCRYPTION_KEY);
  if (key === null) {
    return null;
  }
  return {
    keyVersion: values.LOOMCAST_ENCRYPTION_KEY_VERSION,
    key,
    previousKeys:
      values.LOOMCAST_ENCRYPTION_KEYS_PREVIOUS === undefined
        ? new Map()
        : parsePreviousVaultKeys(values.LOOMCAST_ENCRYPTION_KEYS_PREVIOUS).keys,
  };
}

const VaultEnvSchema = z
  .object({ DATABASE_URL: PostgresUrlSchema, NODE_ENV: NodeEnvSchema, ...EncryptionEnvShape })
  .superRefine(refineEncryption);

export interface VaultCliConfig {
  databaseUrl: string;
  /** Null when `LOOMCAST_ENCRYPTION_KEY` is not set. */
  encryption: VaultKeyring | null;
}

/**
 * The settings the vault CLI needs: the database and the keys. Lighter than `parseConfig`, so a
 * rotation can run with only these variables set. Throws `ConfigError`.
 */
export function parseVaultCliConfig(
  env: Record<string, string | undefined> = process.env,
): VaultCliConfig {
  const parsed = VaultEnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => `${issue.path.join(".") || "env"}: ${issue.message}`),
    );
  }
  return { databaseUrl: parsed.data.DATABASE_URL, encryption: encryptionConfig(parsed.data) };
}

/** Loads the root `.env` (outside production) and parses the environment. */
export function loadConfig(): Config {
  loadRootEnv();
  return parseConfig(process.env);
}
