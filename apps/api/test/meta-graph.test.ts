import { createHmac } from "node:crypto";
import { Writable } from "node:stream";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { runMetaCheck } from "../src/cli/meta-check";
import { ConfigError, parseConfig } from "../src/env";
import { createLogger } from "../src/lib/logger";
import {
  appSecretProof,
  classifyMetaError,
  classifyMetaErrorCode,
  createGraphClient,
  createMetaGraphClient,
  createThreadsGraphClient,
  type GraphClientOptions,
  MetaGraphError,
  regainAccessDelayMs,
} from "../src/lib/meta-graph";
import {
  answer,
  fakeCredential,
  fakeMetaApp,
  fakeThreadsApp,
  formOf,
  GRAPH_ORIGIN,
  GRAPH_VERSION,
  graphError,
  installMockAgent,
  platformsWith,
  type SeenRequest,
  THREADS_ORIGIN,
} from "./oauth-support";

let mock: ReturnType<typeof installMockAgent>;

beforeAll(() => {
  mock = installMockAgent();
});

afterAll(async () => {
  await mock.restore();
});

afterEach(() => {
  mock.agent.assertNoPendingInterceptors();
});

const graph = () => mock.agent.get(GRAPH_ORIGIN);

/** A client that records its retry waits instead of sleeping. */
function client(options: Partial<GraphClientOptions> = {}) {
  const waits: number[] = [];
  const instance = createGraphClient({
    baseUrl: `${GRAPH_ORIGIN}/`,
    version: GRAPH_VERSION,
    appSecret: options.appSecret === undefined ? fakeCredential("secret") : options.appSecret,
    random: () => 0.5,
    sleep: async (ms) => {
      waits.push(ms);
    },
    ...options,
  });
  return { client: instance, waits };
}

async function failure(promise: Promise<unknown>): Promise<MetaGraphError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof MetaGraphError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected the call to fail");
}

describe("appsecret_proof", () => {
  it("is the hex HMAC-SHA256 of the token keyed with the app secret", () => {
    const token = fakeCredential("token");
    const secret = fakeCredential("secret");
    expect(appSecretProof(token, secret)).toBe(
      createHmac("sha256", secret).update(token).digest("hex"),
    );
    expect(appSecretProof(token, secret)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("classifyMetaError", () => {
  it.each([
    [{ status: 400, code: 190 }, "auth"],
    [{ status: 400, code: 190, subcode: 463 }, "auth"],
    [{ status: 400, code: 102 }, "auth"],
    [{ status: 403, code: 10 }, "permission"],
    [{ status: 403, code: 200 }, "permission"],
    [{ status: 403, code: 299 }, "permission"],
    [{ status: 400, code: 4 }, "rate_limited"],
    [{ status: 400, code: 17 }, "rate_limited"],
    [{ status: 400, code: 32 }, "rate_limited"],
    [{ status: 400, code: 613 }, "rate_limited"],
    [{ status: 400, code: 80_002 }, "rate_limited"],
    [{ status: 500, code: 1 }, "transient"],
    [{ status: 500, code: 2 }, "transient"],
    [{ status: 503 }, "transient"],
    [{ status: null }, "transient"],
    [{ status: 400, code: 100, isTransient: true }, "transient"],
    [{ status: 400, code: 9004 }, "invalid_media"],
    [{ status: 400, code: 352 }, "invalid_media"],
    [{ status: 400, code: 100, subcode: 2_207_026 }, "invalid_media"],
    [{ status: 400, code: 100, subcode: 1_363_040 }, "invalid_media"],
    [{ status: 500, code: -2, subcode: 2_207_001 }, "transient"],
    [{ status: 400, code: 100 }, "permanent"],
    [{ status: 400, code: 506 }, "permanent"],
  ] as const)("%j → %s", (fields, expected) => {
    expect(classifyMetaErrorCode(fields)).toBe(expected);
  });

  it("keeps the platform code, the wait for throttling and no URL in the message", () => {
    const leaked = new URL("https://developers.example.test/x");
    leaked.searchParams.set(["access", "token"].join("_"), fakeCredential("token"));
    const error = classifyMetaError(
      { status: 400, code: 4, subcode: 1_349_210 },
      `Too many calls, see ${leaked.toString()} for details`,
      { retryAfterMs: 120_000 },
    );
    expect(error).toEqual({
      code: "rate_limited",
      retryable: true,
      retryAfterMs: 120_000,
      platformCode: "4/1349210",
      message: "Too many calls, see [url] for details",
    });
    expect(classifyMetaError({ status: 400, code: 190 }, "Expired")).toMatchObject({
      code: "auth",
      retryable: false,
    });
  });

  it("reads the wait from the business use case usage", () => {
    expect(
      regainAccessDelayMs({
        appUsage: null,
        businessUseCaseUsage: {
          "123": [
            { type: "pages", call_count: 100, estimated_time_to_regain_access: 4 },
            { type: "instagram", call_count: 10, estimated_time_to_regain_access: 0 },
          ],
        },
      }),
    ).toBe(4 * 60_000);
    expect(regainAccessDelayMs(null)).toBeUndefined();
  });
});

describe("graph client", () => {
  it("sends the token as a bearer header with appsecret_proof on the versioned URL", async () => {
    const secret = fakeCredential("secret");
    const token = fakeCredential("token");
    const seen: SeenRequest[] = [];
    answer(
      graph(),
      "GET",
      `/${GRAPH_VERSION}/me`,
      {
        body: { id: "42" },
        headers: {
          "x-app-usage": JSON.stringify({ call_count: 12, total_time: 3, total_cputime: 2 }),
          "x-business-use-case-usage": JSON.stringify({ "1": [{ type: "pages", call_count: 5 }] }),
        },
      },
      seen,
    );
    const { client: graphClient } = client({ appSecret: secret });
    const response = await graphClient.request({
      path: "/me",
      query: { fields: "id", empty: undefined },
      accessToken: token,
    });
    expect(response.data).toEqual({ id: "42" });
    expect(response.usage).toEqual({
      appUsage: { call_count: 12, total_time: 3, total_cputime: 2 },
      businessUseCaseUsage: { "1": [{ type: "pages", call_count: 5 }] },
    });
    expect(seen[0]?.headers.authorization).toBe(`Bearer ${token}`);
    expect(seen[0]?.query.get("appsecret_proof")).toBe(appSecretProof(token, secret));
    expect(seen[0]?.query.get("fields")).toBe("id");
    expect(seen[0]?.query.has("empty")).toBe(false);
    expect(seen[0]?.query.has("access_token")).toBe(false);
  });

  it("puts the token in the query or the form for the Threads API, without a proof", async () => {
    const threads = mock.agent.get(THREADS_ORIGIN);
    const token = fakeCredential("token");
    const seen: SeenRequest[] = [];
    answer(threads, "GET", "/v1.0/me", { body: { id: "1" } }, seen);
    answer(threads, "POST", "/v1.0/1/threads", { body: { id: "2" } }, seen);
    const threadsClient = createThreadsGraphClient({ threadsGraphBaseUrl: THREADS_ORIGIN });
    await threadsClient.request({ path: "/me", accessToken: token });
    await threadsClient.request({
      method: "POST",
      path: "/1/threads",
      form: { media_type: "VIDEO" },
      accessToken: token,
    });
    expect(seen[0]?.query.get("access_token")).toBe(token);
    expect(seen[0]?.query.has("appsecret_proof")).toBe(false);
    expect(seen[0]?.headers.authorization).toBeUndefined();
    const form = await formOf(seen[1]);
    expect(form.get("access_token")).toBe(token);
    expect(form.get("media_type")).toBe("VIDEO");
    expect(seen[1]?.query.has("access_token")).toBe(false);
  });

  it("builds the Meta client from the platform settings", async () => {
    const app = fakeMetaApp();
    const token = fakeCredential("token");
    const seen: SeenRequest[] = [];
    answer(graph(), "GET", `/${GRAPH_VERSION}/me`, { body: { id: "1" } }, seen);
    const metaClient = createMetaGraphClient(platformsWith({ meta: app }, "https://a.test"));
    await metaClient.request({ path: "/me", accessToken: token });
    expect(seen[0]?.query.get("appsecret_proof")).toBe(appSecretProof(token, app.appSecret));
  });

  it("retries transient failures of a GET with jittered backoff", async () => {
    answer(graph(), "GET", `/${GRAPH_VERSION}/me`, { status: 500, body: graphError(2, "Down") });
    answer(graph(), "GET", `/${GRAPH_VERSION}/me`, { status: 503, body: "unavailable" });
    answer(graph(), "GET", `/${GRAPH_VERSION}/me`, { body: { id: "1" } });
    const { client: graphClient, waits } = client();
    const response = await graphClient.request({ path: "/me" });
    expect(response.data).toEqual({ id: "1" });
    // random() = 0.5 → factor 1: 500 ms, then 1 s.
    expect(waits).toEqual([500, 1_000]);
  });

  it("gives up after two retries and never retries a POST unless asked", async () => {
    for (let index = 0; index < 3; index += 1) {
      answer(graph(), "GET", `/${GRAPH_VERSION}/me`, { status: 500, body: graphError(1, "Down") });
    }
    const first = client();
    const exhausted = await failure(first.client.request({ path: "/me" }));
    expect(exhausted.error).toMatchObject({ code: "transient", retryable: true });
    expect(first.waits).toHaveLength(2);

    answer(graph(), "POST", `/${GRAPH_VERSION}/1/media`, { status: 500, body: graphError(2, "x") });
    const second = client();
    await failure(second.client.request({ method: "POST", path: "/1/media", form: { a: "b" } }));
    expect(second.waits).toEqual([]);
  });

  it("does not retry auth, permission or throttling errors", async () => {
    answer(graph(), "GET", `/${GRAPH_VERSION}/me`, {
      status: 400,
      body: graphError(190, "Error validating access token", 463),
    });
    const { client: graphClient, waits } = client();
    const error = await failure(graphClient.request({ path: "/me" }));
    expect(error.error).toMatchObject({ code: "auth", retryable: false, platformCode: "190/463" });
    expect(error.fields).toMatchObject({ status: 400, code: 190, subcode: 463 });
    expect(waits).toEqual([]);

    answer(graph(), "GET", `/${GRAPH_VERSION}/me`, {
      status: 400,
      body: graphError(80_001, "Too many calls to this Page"),
      headers: {
        "x-business-use-case-usage": JSON.stringify({
          "9": [{ type: "pages", call_count: 100, estimated_time_to_regain_access: 7 }],
        }),
      },
    });
    const throttled = await failure(client().client.request({ path: "/me" }));
    expect(throttled.error).toMatchObject({ code: "rate_limited", retryAfterMs: 7 * 60_000 });
    expect(throttled.usage?.businessUseCaseUsage).not.toBeNull();
  });

  it("times out after the configured time as a transient failure", async () => {
    graph()
      .intercept({ method: "GET", path: `/${GRAPH_VERSION}/slow` })
      .reply(200, { id: "1" })
      .delay(500);
    const { client: graphClient } = client({ timeoutMs: 50, maxRetries: 0 });
    const error = await failure(graphClient.request({ path: "/slow" }));
    expect(error.error).toMatchObject({
      code: "transient",
      message: "The platform did not answer in time.",
    });
  });

  it("reports a network failure without the URL or the token", async () => {
    const token = fakeCredential("token");
    const { client: graphClient } = client({
      baseUrl: "https://unreachable.invalid",
      maxRetries: 0,
    });
    const error = await failure(
      graphClient.request({ path: "/me", query: { client_secret: token }, accessToken: token }),
    );
    expect(error.error.code).toBe("transient");
    expect(error.message).not.toContain(token);
    expect(JSON.stringify(error.toLog())).not.toContain(token);
  });

  it("aborts with the caller's signal", async () => {
    graph()
      .intercept({ method: "GET", path: `/${GRAPH_VERSION}/me` })
      .reply(200, {})
      .delay(500);
    const controller = new AbortController();
    const pending = client().client.request({ path: "/me", signal: controller.signal });
    controller.abort(new Error("stopped"));
    await expect(pending).rejects.toThrow("stopped");
  });
});

describe("log redaction", () => {
  it("redacts platform credentials and callback codes but keeps error codes", () => {
    const lines: string[] = [];
    const logger = createLogger({
      level: "info",
      destination: { write: (line: string) => void lines.push(line) },
    });
    const secret = fakeCredential("secret");
    logger.info(
      {
        request: { access_token: secret, client_secret: secret, appsecret_proof: secret },
        query: { code: secret, state: "s" },
        config: { platforms: { meta: { appSecret: secret } } },
        failure: { code: "auth", platformCode: "190" },
      },
      "probe",
    );
    expect(lines.join("")).not.toContain(secret);
    expect(JSON.parse(lines[0] ?? "{}").failure).toEqual({ code: "auth", platformCode: "190" });
  });
});

const BASE_ENV = {
  DATABASE_URL: "postgres://user@127.0.0.1:5432/db",
  APP_ORIGIN: "https://loomcast.example.test",
  PUBLIC_BASE_URL: "https://media.example.test",
};

describe("platform settings", () => {
  it("defaults the version, hosts and redirect base, with no apps", () => {
    const config = parseConfig(BASE_ENV);
    expect(config.platforms).toEqual({
      redirectBase: "https://loomcast.example.test",
      metaGraphVersion: "v26.0",
      metaGraphBaseUrl: "https://graph.facebook.com",
      threadsGraphBaseUrl: "https://graph.threads.net",
      meta: null,
      threads: null,
    });
  });

  it("reads both apps and the overrides", () => {
    const meta = fakeMetaApp();
    const threads = fakeThreadsApp();
    const config = parseConfig({
      ...BASE_ENV,
      META_APP_ID: meta.appId,
      META_APP_SECRET: meta.appSecret,
      META_LOGIN_CONFIG_ID: meta.loginConfigId,
      META_GRAPH_VERSION: "v27.0",
      META_GRAPH_BASE_URL: "http://127.0.0.1:9999/",
      THREADS_APP_ID: threads.appId,
      THREADS_APP_SECRET: threads.appSecret,
      THREADS_GRAPH_BASE_URL: "http://127.0.0.1:9998",
      OAUTH_REDIRECT_BASE: "https://tunnel.example.test/",
    });
    expect(config.platforms).toEqual({
      redirectBase: "https://tunnel.example.test",
      metaGraphVersion: "v27.0",
      metaGraphBaseUrl: "http://127.0.0.1:9999",
      threadsGraphBaseUrl: "http://127.0.0.1:9998",
      meta,
      threads,
    });
  });

  it("refuses a partial app or a malformed version, without echoing values", () => {
    const secret = fakeCredential("secret");
    let error: unknown;
    try {
      parseConfig({ ...BASE_ENV, META_APP_SECRET: secret, META_GRAPH_VERSION: "26" });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConfigError);
    const message = (error as ConfigError).message;
    expect(message).toContain("META_APP_ID");
    expect(message).toContain("META_LOGIN_CONFIG_ID");
    expect(message).toContain("META_GRAPH_VERSION");
    expect(message).not.toContain(secret);
    expect(() => parseConfig({ ...BASE_ENV, THREADS_APP_ID: "1" })).toThrow(/THREADS_APP_SECRET/);
  });

  it("needs no platform setting in production", () => {
    expect(
      parseConfig({
        ...BASE_ENV,
        NODE_ENV: "production",
        LOOMCAST_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
        S3_ENDPOINT: "https://s3.example.test",
        S3_ACCESS_KEY: fakeCredential("access"),
        S3_SECRET_KEY: fakeCredential("secret"),
      }).platforms.meta,
    ).toBeNull();
  });
});

class Capture extends Writable {
  text = "";
  override _write(chunk: Buffer, _encoding: string, callback: () => void): void {
    this.text += chunk.toString();
    callback();
  }
}

describe("meta:check", () => {
  function io() {
    return { stdout: new Capture(), stderr: new Capture() };
  }

  it("checks both apps with app access tokens and prints the redirect URIs", async () => {
    const meta = fakeMetaApp();
    const threads = fakeThreadsApp();
    const appToken = fakeCredential("app-token");
    const threadsToken = fakeCredential("threads-token");
    const seen: SeenRequest[] = [];
    answer(
      graph(),
      "GET",
      `/${GRAPH_VERSION}/oauth/access_token`,
      { body: { access_token: appToken, token_type: "bearer" } },
      seen,
    );
    answer(
      graph(),
      "GET",
      `/${GRAPH_VERSION}/${meta.appId}`,
      { body: { id: meta.appId, name: "Loomcast" } },
      seen,
    );
    answer(
      mock.agent.get(THREADS_ORIGIN),
      "GET",
      "/oauth/access_token",
      { body: { access_token: threadsToken, token_type: "bearer" } },
      seen,
    );
    const out = io();
    const code = await runMetaCheck([], out, {
      APP_ORIGIN: "https://loomcast.example.test",
      META_APP_ID: meta.appId,
      META_APP_SECRET: meta.appSecret,
      META_LOGIN_CONFIG_ID: meta.loginConfigId,
      THREADS_APP_ID: threads.appId,
      THREADS_APP_SECRET: threads.appSecret,
    });
    expect(out.stderr.text).toBe("");
    expect(code).toBe(0);
    expect(seen[0]?.query.get("grant_type")).toBe("client_credentials");
    expect(seen[0]?.query.get("client_id")).toBe(meta.appId);
    expect(seen[1]?.headers.authorization).toBe(`Bearer ${appToken}`);
    expect(seen[1]?.query.get("appsecret_proof")).toBe(appSecretProof(appToken, meta.appSecret));
    expect(seen[2]?.query.get("client_id")).toBe(threads.appId);
    expect(seen[2]?.query.get("grant_type")).toBe("client_credentials");
    expect(out.stdout.text).toContain(`Meta: OK, app ${meta.appId} (Loomcast), Graph API v26.0`);
    expect(out.stdout.text).toContain(`Threads: OK, app ${threads.appId}`);
    expect(out.stdout.text).toContain("https://loomcast.example.test/api/oauth/meta/callback");
    expect(out.stdout.text).toContain("https://loomcast.example.test/api/oauth/threads/callback");
    for (const secret of [meta.appSecret, threads.appSecret, appToken, threadsToken]) {
      expect(out.stdout.text + out.stderr.text).not.toContain(secret);
    }
  });

  it("fails when the platform refuses the credentials, or nothing is configured", async () => {
    const meta = fakeMetaApp();
    answer(graph(), "GET", `/${GRAPH_VERSION}/oauth/access_token`, {
      status: 400,
      body: graphError(101, "Error validating application. Invalid application ID."),
    });
    const out = io();
    const code = await runMetaCheck([], out, {
      META_APP_ID: meta.appId,
      META_APP_SECRET: meta.appSecret,
      META_LOGIN_CONFIG_ID: meta.loginConfigId,
    });
    expect(code).toBe(1);
    expect(out.stderr.text).toContain(
      "Meta: FAILED, permanent (101): Error validating application. Invalid application ID.",
    );
    expect(out.stderr.text + out.stdout.text).not.toContain(meta.appSecret);

    const empty = io();
    expect(await runMetaCheck([], empty, {})).toBe(1);
    expect(empty.stderr.text).toContain("Neither the Meta app nor the Threads app is configured");
    expect(await runMetaCheck(["extra"], io(), {})).toBe(2);
  });
});
