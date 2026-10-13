import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type PublishingMode, PublishingModeSchema } from "@loomcast/contracts";
import { z } from "zod";
import { ALERT_FORMATS, type AlertsConfig } from "./lib/alerts";
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

/** Graph API version the Meta client targets when `META_GRAPH_VERSION` is not set. */
export const DEFAULT_META_GRAPH_VERSION = "v26.0";

/** The Graph API host. Tests and E2E runs may point `META_GRAPH_BASE_URL` at a fake. */
export const DEFAULT_META_GRAPH_BASE_URL = "https://graph.facebook.com";

/** The Threads API host. Tests and E2E runs may point `THREADS_GRAPH_BASE_URL` at a fake. */
export const DEFAULT_THREADS_GRAPH_BASE_URL = "https://graph.threads.net";

/** The X API host. Tests and E2E runs may point `X_API_BASE_URL` at a fake. */
export const DEFAULT_X_API_BASE_URL = "https://api.x.com";

/** A base URL without a trailing slash; an empty value counts as unset. */
const optionalBaseUrl = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z
    .url({ protocol: /^https?$/ })
    .transform((value) => value.replace(/\/+$/, ""))
    .optional(),
);

/** Settings of each sign-in provider: all set, or all unset. */
const OAUTH_PROVIDER_KEYS = {
  meta: ["META_APP_ID", "META_APP_SECRET", "META_LOGIN_CONFIG_ID"],
  threads: ["THREADS_APP_ID", "THREADS_APP_SECRET"],
  x: ["X_CLIENT_ID", "X_CLIENT_SECRET"],
} as const;

const PlatformsEnvShape = {
  /** Meta app (Facebook Login for Business, Pages and Instagram): app id, secret, login config. */
  META_APP_ID: optionalText,
  META_APP_SECRET: optionalText,
  META_LOGIN_CONFIG_ID: optionalText,
  /** Graph API version, such as `v26.0`. */
  META_GRAPH_VERSION: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z
      .string()
      .regex(/^v\d{1,3}\.\d{1,2}$/, "Expected a Graph API version such as v26.0")
      .default(DEFAULT_META_GRAPH_VERSION),
  ),
  META_GRAPH_BASE_URL: optionalBaseUrl,
  /** Threads app id and secret (the Threads use case has its own pair). */
  THREADS_APP_ID: optionalText,
  THREADS_APP_SECRET: optionalText,
  THREADS_GRAPH_BASE_URL: optionalBaseUrl,
  /**
   * X publishing feature flag, off by default. While it is off nothing is sent to X: X is not
   * offered for connecting, X channels cannot be created and the X adapter refuses every post.
   */
  FEATURE_X_PUBLISHING: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.stringbool().default(false),
  ),
  /** X app OAuth 2.0 client id and secret (a confidential client). */
  X_CLIENT_ID: optionalText,
  X_CLIENT_SECRET: optionalText,
  X_API_BASE_URL: optionalBaseUrl,
};

interface PlatformsEnv {
  META_APP_ID?: string | undefined;
  META_APP_SECRET?: string | undefined;
  META_LOGIN_CONFIG_ID?: string | undefined;
  META_GRAPH_VERSION: string;
  META_GRAPH_BASE_URL?: string | undefined;
  THREADS_APP_ID?: string | undefined;
  THREADS_APP_SECRET?: string | undefined;
  THREADS_GRAPH_BASE_URL?: string | undefined;
  FEATURE_X_PUBLISHING: boolean;
  X_CLIENT_ID?: string | undefined;
  X_CLIENT_SECRET?: string | undefined;
  X_API_BASE_URL?: string | undefined;
}

/** Each provider's settings are all set or all unset. Messages never include the values. */
function refinePlatforms(env: PlatformsEnv, ctx: z.RefinementCtx): void {
  for (const keys of Object.values(OAUTH_PROVIDER_KEYS)) {
    const missing = keys.filter((key) => env[key] === undefined);
    if (missing.length === 0 || missing.length === keys.length) {
      continue;
    }
    for (const key of missing) {
      ctx.addIssue({ code: "custom", path: [key], message: `Set ${keys.join(", ")} together` });
    }
  }
}

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
    /**
     * Webhook that receives alerts (dead tasks, publish failures, reauthorisation, stale backups).
     * Holds a secret in its path or query. Unset: alerts are only logged.
     */
    ALERT_WEBHOOK_URL: z.preprocess(
      (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
      z.url({ protocol: /^https?$/ }).optional(),
    ),
    /** `json` (any receiver), `ntfy` or `slack` (Slack-compatible incoming webhook). */
    ALERT_WEBHOOK_FORMAT: z.preprocess(
      (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
      z.enum(ALERT_FORMATS).default("json"),
    ),
    /** Commit the image was built from; the production image sets it. Shown on the ops status. */
    LOOMCAST_GIT_SHA: z.preprocess(
      (value) =>
        typeof value === "string" && (value.trim() === "" || value.trim() === "unknown")
          ? undefined
          : value,
      z
        .string()
        .regex(/^[\w.-]{1,64}$/, "Expected a commit id (letters, digits, '.', '_', '-')")
        .optional(),
    ),
    /**
     * The backup service's directory, mounted read-only (`/backups` in production). The api reads
     * `last-success.json` there for the ops status and alerts when it is older than 26 hours.
     */
    BACKUP_DIR: z.preprocess(
      (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
      z
        .string()
        .refine((value) => isAbsolute(value), { message: "Expected an absolute path" })
        .optional(),
    ),
    ...PlatformsEnvShape,
    /** Base of the OAuth redirect URIs registered with the platforms. Defaults to `APP_ORIGIN`. */
    OAUTH_REDIRECT_BASE: z.preprocess(
      (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
      OriginSchema.optional(),
    ),
  })
  .superRefine(refineEncryption)
  .superRefine(refinePlatforms)
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
  /** Alert webhook. `webhookUrl` holds a secret: never log it. */
  alerts: AlertsConfig;
  /** `LOOMCAST_GIT_SHA`, or null when the build did not record it. */
  gitSha: string | null;
  /** Directory holding the backup service's `last-success.json`, or null when not mounted. */
  backupDir: string | null;
  /** Sign-in providers and platform API hosts. Holds app secrets: never log it. */
  platforms: PlatformsConfig;
}

/** A Meta app: Facebook Login for Business, Pages and Instagram. */
export interface MetaAppConfig {
  appId: string;
  appSecret: string;
  /** The Facebook Login for Business configuration the login dialog uses. */
  loginConfigId: string;
}

/** The Threads app of the Threads use case. */
export interface ThreadsAppConfig {
  appId: string;
  appSecret: string;
}

/** The X app: an OAuth 2.0 confidential client. */
export interface XAppConfig {
  clientId: string;
  clientSecret: string;
}

export interface PlatformsConfig {
  /** Origin the OAuth redirect URIs start with (`OAUTH_REDIRECT_BASE`, default `APP_ORIGIN`). */
  redirectBase: string;
  /** Graph API version, such as `v26.0`. */
  metaGraphVersion: string;
  /** Graph API host, without a version or trailing slash. */
  metaGraphBaseUrl: string;
  /** Threads API host, without a version or trailing slash. */
  threadsGraphBaseUrl: string;
  /** Null until `META_APP_ID`, `META_APP_SECRET` and `META_LOGIN_CONFIG_ID` are set. */
  meta: MetaAppConfig | null;
  /** Null until `THREADS_APP_ID` and `THREADS_APP_SECRET` are set. */
  threads: ThreadsAppConfig | null;
  /**
   * `FEATURE_X_PUBLISHING`. Absent or false: X is off and nothing is ever sent to it. Optional so
   * settings built before X existed read as off.
   */
  xPublishing?: boolean;
  /** Null (or absent) until `X_CLIENT_ID` and `X_CLIENT_SECRET` are set. */
  x?: XAppConfig | null;
  /** X API host, without a trailing slash. Absent means `DEFAULT_X_API_BASE_URL`. */
  xApiBaseUrl?: string;
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
    alerts: {
      webhookUrl: values.ALERT_WEBHOOK_URL ?? null,
      format: values.ALERT_WEBHOOK_FORMAT,
    },
    gitSha: values.LOOMCAST_GIT_SHA ?? null,
    backupDir: values.BACKUP_DIR ?? null,
    platforms: {
      ...platformsConfig(values),
      redirectBase: values.OAUTH_REDIRECT_BASE ?? values.APP_ORIGIN,
    },
  };
}

/** The platform apps and hosts from validated settings, without the redirect base. */
function platformsConfig(values: PlatformsEnv): Omit<PlatformsConfig, "redirectBase"> {
  return {
    metaGraphVersion: values.META_GRAPH_VERSION,
    metaGraphBaseUrl: values.META_GRAPH_BASE_URL ?? DEFAULT_META_GRAPH_BASE_URL,
    threadsGraphBaseUrl: values.THREADS_GRAPH_BASE_URL ?? DEFAULT_THREADS_GRAPH_BASE_URL,
    meta:
      values.META_APP_ID === undefined ||
      values.META_APP_SECRET === undefined ||
      values.META_LOGIN_CONFIG_ID === undefined
        ? null
        : {
            appId: values.META_APP_ID,
            appSecret: values.META_APP_SECRET,
            loginConfigId: values.META_LOGIN_CONFIG_ID,
          },
    threads:
      values.THREADS_APP_ID === undefined || values.THREADS_APP_SECRET === undefined
        ? null
        : { appId: values.THREADS_APP_ID, appSecret: values.THREADS_APP_SECRET },
    // The X settings appear only once set: absent reads as off, unconfigured and the default host.
    ...(values.FEATURE_X_PUBLISHING ? { xPublishing: true } : {}),
    ...(values.X_CLIENT_ID === undefined || values.X_CLIENT_SECRET === undefined
      ? {}
      : { x: { clientId: values.X_CLIENT_ID, clientSecret: values.X_CLIENT_SECRET } }),
    ...(values.X_API_BASE_URL === undefined ? {} : { xApiBaseUrl: values.X_API_BASE_URL }),
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

const MetaCheckEnvSchema = z
  .object({
    APP_ORIGIN: OriginSchema.optional(),
    OAUTH_REDIRECT_BASE: z.preprocess(
      (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
      OriginSchema.optional(),
    ),
    ...PlatformsEnvShape,
  })
  .superRefine(refinePlatforms);

export interface MetaCheckConfig extends Omit<PlatformsConfig, "redirectBase"> {
  /** Null when neither `OAUTH_REDIRECT_BASE` nor `APP_ORIGIN` is set. */
  redirectBase: string | null;
}

/**
 * The settings `meta:check` needs: the platform apps and hosts, and the redirect base. Lighter
 * than `parseConfig`, so the check runs without a database. Throws `ConfigError`.
 */
export function parseMetaCheckConfig(
  env: Record<string, string | undefined> = process.env,
): MetaCheckConfig {
  const parsed = MetaCheckEnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => `${issue.path.join(".") || "env"}: ${issue.message}`),
    );
  }
  return {
    ...platformsConfig(parsed.data),
    redirectBase: parsed.data.OAUTH_REDIRECT_BASE ?? parsed.data.APP_ORIGIN ?? null,
  };
}

/** Loads the root `.env` (outside production) and parses the environment. */
export function loadConfig(): Config {
  loadRootEnv();
  return parseConfig(process.env);
}
