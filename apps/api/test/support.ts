import { randomUUID } from "node:crypto";
import type { UserRole } from "@loomcast/contracts";
import { type Database, type UserRow, users } from "@loomcast/db";
import type { Hono } from "hono";
import { type CreateAppOptions, createApp } from "../src/app";
import type { AppDeps } from "../src/deps";
import type { Config } from "../src/env";
import { createEventBus, type EventBus } from "../src/lib/bus";
import type { Clock } from "../src/lib/clock";
import { createLifecycle } from "../src/lib/lifecycle";
import { createLogger } from "../src/lib/logger";
import { hashPassword } from "../src/lib/password";
import type { AppEnv } from "../src/types";

export const APP_ORIGIN = "http://localhost:5173";
/** A fresh random password per test run, so no credential-like literals live in the suite. */
export function testPassword(label: string): string {
  return `${label}-${randomUUID()}`;
}

export const PASSWORD = testPassword("login");

/** An address from the TEST-NET-1 documentation range. */
export function testIp(host: number): string {
  return `192.0.2.${host}`;
}

export interface TestClock extends Clock {
  advance(ms: number): void;
  set(date: Date): void;
}

export function createTestClock(start: Date = new Date()): TestClock {
  let current = start.getTime();
  return {
    now: () => new Date(current),
    advance: (ms) => {
      current += ms;
    },
    set: (date) => {
      current = date.getTime();
    },
  };
}

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    databaseUrl: "postgres://unused@127.0.0.1:1/unused",
    appOrigin: APP_ORIGIN,
    port: 0,
    host: "127.0.0.1",
    nodeEnv: "test",
    isProduction: false,
    logLevel: "silent",
    publicBaseUrl: "https://media.example.test",
    webDistDir: null,
    // Lets tests vary the client address with X-Forwarded-For.
    trustProxy: true,
    // Unreachable by default; storage tests use `test/storage-support.ts`.
    storage: {
      endpoint: "http://127.0.0.1:9",
      region: "auto",
      forcePathStyle: true,
      bucket: "loomcast-media",
      publicBucket: "loomcast-public",
      accessKeyId: testPassword("s3-access"),
      secretAccessKey: testPassword("s3-secret"),
      publicBaseUrl: "https://media.example.test",
    },
    assetVerifyMaxBytes: 512 * 1024 * 1024,
    // No vault keys by default; vault tests pass a keyring generated at runtime.
    encryption: null,
    // Tests drive scheduler ticks themselves.
    scheduler: { enabled: false, tickMs: 5_000 },
    publishing: { mode: "dry-run", enabled: true },
    cadenceHorizonDays: 14,
    // No webhook: alerts are only logged.
    alerts: { webhookUrl: null, format: "json" },
    gitSha: null,
    backupDir: null,
    // No platform apps by default; the sign-in tests pass app credentials generated at runtime.
    platforms: {
      redirectBase: APP_ORIGIN,
      metaGraphVersion: "v26.0",
      metaGraphBaseUrl: "https://graph.facebook.com",
      threadsGraphBaseUrl: "https://graph.threads.net",
      meta: null,
      threads: null,
    },
    ...overrides,
  };
}

export interface TestApp {
  app: Hono<AppEnv>;
  deps: AppDeps;
  clock: TestClock;
  bus: EventBus;
  /** Every log line the app wrote, at trace level and above. */
  logs: string[];
}

export function createTestApp(
  db: Database,
  options: { config?: Partial<Config>; clock?: TestClock } & CreateAppOptions = {},
): TestApp {
  const logs: string[] = [];
  const logger = createLogger({
    level: "trace",
    destination: { write: (line: string) => void logs.push(line) },
  });
  const clock = options.clock ?? createTestClock();
  const bus = createEventBus(logger);
  const deps: AppDeps = {
    db,
    bus,
    clock,
    logger,
    config: testConfig(options.config),
    lifecycle: createLifecycle(logger),
  };
  const app = createApp(deps, { modules: options.modules });
  return { app, deps, clock, bus, logs };
}

let cachedHash: Promise<string> | null = null;

/** Inserts an account whose password is `PASSWORD` (hashed once per test file). */
export async function insertUser(
  db: Database,
  values: { role?: UserRole; email?: string; disabledAt?: Date | null } = {},
): Promise<UserRow> {
  cachedHash ??= hashPassword(PASSWORD);
  const [user] = await db
    .insert(users)
    .values({
      email: values.email ?? `user-${randomUUID()}@example.test`,
      name: "Test User",
      role: values.role ?? "admin",
      passwordHash: await cachedHash,
      disabledAt: values.disabledAt ?? null,
    })
    .returning();
  if (user === undefined) {
    throw new Error("user was not inserted");
  }
  return user;
}

export interface RequestOptions {
  body?: unknown;
  cookie?: string;
  /** Defaults to the app origin. Pass null to omit the header. */
  origin?: string | null;
  /** Defaults to application/json when there is a body or the method is unsafe. */
  contentType?: string | null;
  ip?: string;
  headers?: Record<string, string>;
}

/** Sends a request the way the web app does: same origin, JSON, with the session cookie. */
export function send(
  app: Hono<AppEnv>,
  method: string,
  path: string,
  options: RequestOptions = {},
): Promise<Response> {
  const headers = new Headers(options.headers);
  const unsafe = !["GET", "HEAD", "OPTIONS"].includes(method);
  const origin = options.origin === undefined ? APP_ORIGIN : options.origin;
  if (origin !== null && unsafe) {
    headers.set("Origin", origin);
  }
  const contentType =
    options.contentType === undefined
      ? unsafe || options.body !== undefined
        ? "application/json"
        : null
      : options.contentType;
  if (contentType !== null) {
    headers.set("Content-Type", contentType);
  }
  if (options.cookie !== undefined) {
    headers.set("Cookie", options.cookie);
  }
  headers.set("X-Forwarded-For", options.ip ?? "203.0.113.10");
  const body =
    options.body === undefined
      ? undefined
      : typeof options.body === "string"
        ? options.body
        : JSON.stringify(options.body);
  return Promise.resolve(app.request(path, { method, headers, body }));
}

/** The `name=value` part of the session cookie set by `response`, or null. */
export function sessionCookie(response: Response): string | null {
  for (const header of response.headers.getSetCookie()) {
    const pair = header.split(";")[0] ?? "";
    if (/^(__Host-)?lc_session=./.test(pair)) {
      return pair;
    }
  }
  return null;
}

export async function login(
  app: Hono<AppEnv>,
  email: string,
  password = PASSWORD,
  ip?: string,
): Promise<{ response: Response; cookie: string }> {
  const response = await send(app, "POST", "/api/auth/login", { body: { email, password }, ip });
  const cookie = sessionCookie(response);
  if (response.status !== 200 || cookie === null) {
    throw new Error(`login failed with ${response.status}: ${await response.text()}`);
  }
  return { response, cookie };
}

export async function errorCode(response: Response): Promise<string | undefined> {
  const body = (await response.json()) as { error?: { code?: string } };
  return body.error?.code;
}
