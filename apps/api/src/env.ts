import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { StorageConfig } from "./lib/storage/types";

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

const EnvSchema = z
  .object({
    DATABASE_URL: PostgresUrlSchema,
    APP_ORIGIN: OriginSchema,
    API_PORT: z.coerce.number().int().min(0).max(65_535).default(8790),
    /** Interface to bind. Defaults to loopback, or all interfaces in production (inside a container). */
    API_HOST: z.string().min(1).optional(),
    NODE_ENV: z.enum(NODE_ENVS).default("development"),
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
  })
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
  };
}

/** Loads the root `.env` (outside production) and parses the environment. */
export function loadConfig(): Config {
  loadRootEnv();
  return parseConfig(process.env);
}
