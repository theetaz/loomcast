import { randomBytes, randomInt } from "node:crypto";
import type { LiveEvent } from "@loomcast/contracts";
import type { Database } from "@loomcast/db";
import { createTestDb, type TestDb } from "@loomcast/db/testing";
import {
  type Dispatcher,
  getGlobalDispatcher,
  type Interceptable,
  MockAgent,
  setGlobalDispatcher,
} from "undici";
import type { ModuleDeps } from "../src/deps";
import type { MetaAppConfig, PlatformsConfig, ThreadsAppConfig } from "../src/env";
import { testKeyring } from "./publisher-support";
import { createTestApp, insertUser, login, type TestApp } from "./support";

// Sign-in tests answer every Graph and Threads API call with an undici `MockAgent` installed as
// the global dispatcher, so `fetch` never leaves the process. App ids, secrets, codes and tokens
// are generated per run: the suite holds no credential-like literal.

export const GRAPH_ORIGIN = "https://graph.facebook.com";
export const THREADS_ORIGIN = "https://graph.threads.net";
export const GRAPH_VERSION = "v26.0";

/** A random credential-shaped value, so no fixture holds a literal one. */
export function fakeCredential(label: string): string {
  return `${label}-${randomBytes(16).toString("hex")}`;
}

/** A numeric platform id, as the Graph API returns them. */
export function fakeId(): string {
  return String(randomInt(1_000_000, 9_000_000)) + String(randomInt(1_000_000, 9_000_000));
}

export function fakeMetaApp(): MetaAppConfig {
  return { appId: fakeId(), appSecret: fakeCredential("app"), loginConfigId: fakeId() };
}

export function fakeThreadsApp(): ThreadsAppConfig {
  return { appId: fakeId(), appSecret: fakeCredential("threads-app") };
}

/** Installs a `MockAgent` that refuses any call it has no answer for. */
export function installMockAgent(): { agent: MockAgent; restore(): Promise<void> } {
  const previous: Dispatcher = getGlobalDispatcher();
  const agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
  return {
    agent,
    async restore() {
      setGlobalDispatcher(previous);
      await agent.close();
    },
  };
}

/** A request the mock answered, with its query and form fields parsed. */
export interface SeenRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  /** The raw request body, as the dispatcher received it; read it with `formOf`. */
  body: unknown;
}

function headersOf(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (raw === null || raw === undefined) {
    return out;
  }
  if (Array.isArray(raw)) {
    for (let index = 0; index + 1 < raw.length; index += 2) {
      out[String(raw[index]).toLowerCase()] = String(raw[index + 1]);
    }
    return out;
  }
  if (raw instanceof Headers) {
    raw.forEach((value, key) => {
      out[key.toLowerCase()] = value;
    });
    return out;
  }
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    out[key.toLowerCase()] = String(value);
  }
  return out;
}

/**
 * The form fields of a POST the mock answered. The body arrives as an async iterable, readable
 * once the call has completed.
 */
export async function formOf(request: SeenRequest | undefined): Promise<URLSearchParams> {
  const body = request?.body;
  if (typeof body === "string") {
    return new URLSearchParams(body);
  }
  if (body !== null && typeof body === "object" && Symbol.asyncIterator in body) {
    const chunks: Buffer[] = [];
    for await (const chunk of body as AsyncIterable<Uint8Array | string>) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk));
    }
    return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
  }
  return new URLSearchParams();
}

export interface Reply {
  status?: number;
  body: unknown;
  headers?: Record<string, string>;
}

/**
 * Answers the next call to `pathname` (without query) on `pool` with `reply`, and records it in
 * `seen`.
 */
export function answer(
  pool: Interceptable,
  method: string,
  pathname: string,
  reply: Reply | ((request: SeenRequest) => Reply),
  seen?: SeenRequest[],
): void {
  pool
    .intercept({ method, path: (path: string) => path.split("?")[0] === pathname })
    .reply((options) => {
      const [path = "", search = ""] = String(options.path).split("?");
      const request: SeenRequest = {
        method: String(options.method),
        path,
        query: new URLSearchParams(search),
        headers: headersOf(options.headers),
        body: options.body,
      };
      seen?.push(request);
      const result = typeof reply === "function" ? reply(request) : reply;
      return {
        statusCode: result.status ?? 200,
        data: JSON.stringify(result.body),
        responseOptions: {
          headers: { "content-type": "application/json", ...(result.headers ?? {}) },
        },
      };
    });
}

/** A Graph API error body. */
export function graphError(code: number, message: string, subcode?: number): unknown {
  return {
    error: {
      message,
      type: "OAuthException",
      code,
      ...(subcode === undefined ? {} : { error_subcode: subcode }),
      fbtrace_id: "trace",
    },
  };
}

export interface OAuthHarness {
  testDb: TestDb;
  db: Database;
  t: TestApp;
  deps: ModuleDeps;
  cookie: string;
  userId: string;
  live: LiveEvent[];
  meta: MetaAppConfig | null;
  threads: ThreadsAppConfig | null;
  agent: MockAgent;
  graph: Interceptable;
  threadsApi: Interceptable;
  /** Signs in another user of the same app. */
  otherUser(): Promise<{ cookie: string; userId: string }>;
  close(): Promise<void>;
}

export function platformsWith(
  apps: { meta?: MetaAppConfig | null; threads?: ThreadsAppConfig | null },
  redirectBase: string,
): PlatformsConfig {
  return {
    redirectBase,
    metaGraphVersion: GRAPH_VERSION,
    metaGraphBaseUrl: GRAPH_ORIGIN,
    threadsGraphBaseUrl: THREADS_ORIGIN,
    meta: apps.meta ?? null,
    threads: apps.threads ?? null,
  };
}

/** A test app with a vault key, the given platform apps, a signed-in user and a mock agent. */
export async function createOAuthHarness(
  options: { meta?: boolean; threads?: boolean; vault?: boolean } = {},
): Promise<OAuthHarness> {
  const testDb = await createTestDb();
  const meta = options.meta === false ? null : fakeMetaApp();
  const threads = options.threads === false ? null : fakeThreadsApp();
  let deps: ModuleDeps | undefined;
  const t = createTestApp(testDb.db, {
    config: {
      encryption: options.vault === false ? null : testKeyring(),
      platforms: platformsWith({ meta, threads }, "https://loomcast.example.test"),
    },
    modules: [
      (app, moduleDeps) => {
        deps = moduleDeps;
        return app;
      },
    ],
  });
  if (deps === undefined) {
    throw new Error("module deps were not captured");
  }
  const live: LiveEvent[] = [];
  t.bus.subscribeLive((event) => {
    live.push(event);
  });
  const user = await insertUser(testDb.db);
  const { cookie } = await login(t.app, user.email);
  const mock = installMockAgent();
  return {
    testDb,
    db: testDb.db,
    t,
    deps,
    cookie,
    userId: user.id,
    live,
    meta,
    threads,
    agent: mock.agent,
    graph: mock.agent.get(GRAPH_ORIGIN),
    threadsApi: mock.agent.get(THREADS_ORIGIN),
    async otherUser() {
      const other = await insertUser(testDb.db);
      const signedIn = await login(t.app, other.email);
      return { cookie: signedIn.cookie, userId: other.id };
    },
    async close() {
      await mock.restore();
      await t.deps.lifecycle.close();
      await testDb.drop();
    },
  };
}
