import { createHash } from "node:crypto";
import type { Channel, SystemFeatures } from "@loomcast/contracts";
import { channels, oauthStates } from "@loomcast/db";
import { createTestDb, type TestDb } from "@loomcast/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { PlatformsConfig, XAppConfig } from "../src/env";
import { channelAad, createVault, sealedSecretOf } from "../src/lib/vault";
import {
  answer,
  fakeCredential,
  fakeId,
  formOf,
  installMockAgent,
  type SeenRequest,
} from "./oauth-support";
import { testKeyring } from "./publisher-support";
import { createTestApp, insertUser, login, send, type TestApp } from "./support";

// The X sign-in through the app, with every X API call answered by an undici `MockAgent` that
// refuses the network. With the flag off, a catch-all interceptor counts calls to api.x.com: it
// must stay at zero.

const API_ORIGIN = "https://api.x.com";
const REDIRECT_BASE = "https://loomcast.example.test";
const keyring = testKeyring();
let testDb: TestDb;

function platforms(input: { flag: boolean; app: XAppConfig | null }): PlatformsConfig {
  return {
    redirectBase: REDIRECT_BASE,
    metaGraphVersion: "v26.0",
    metaGraphBaseUrl: "https://graph.facebook.com",
    threadsGraphBaseUrl: "https://graph.threads.net",
    meta: null,
    threads: null,
    xPublishing: input.flag,
    x: input.app,
    xApiBaseUrl: API_ORIGIN,
  };
}

function fakeApp(): XAppConfig {
  return { clientId: fakeCredential("client"), clientSecret: fakeCredential("client-secret") };
}

async function signedIn(t: TestApp): Promise<string> {
  const user = await insertUser(testDb.db);
  return (await login(t.app, user.email)).cookie;
}

beforeAll(async () => {
  testDb = await createTestDb();
});

afterAll(async () => {
  await testDb.drop();
});

describe("x sign-in with the flag off", () => {
  let mock: ReturnType<typeof installMockAgent>;
  let reached = 0;

  beforeAll(() => {
    mock = installMockAgent();
    mock.agent
      .get(API_ORIGIN)
      .intercept({ path: () => true, method: () => true })
      .reply(() => {
        reached += 1;
        return { statusCode: 500, data: "{}" };
      })
      .persist();
  });

  afterAll(async () => {
    await mock.restore();
  });

  afterEach(() => {
    expect(reached).toBe(0);
  });

  // Off by default, off with an app configured: both must behave the same.
  for (const [label, settings] of [
    ["without an X app", { flag: false, app: null }],
    ["with an X app configured", { flag: false, app: fakeApp() }],
    ["with the flag on but no X app", { flag: true, app: null }],
  ] as const) {
    describe(label, () => {
      let t: TestApp;
      let cookie: string;

      beforeAll(async () => {
        t = createTestApp(testDb.db, {
          config: { encryption: keyring, platforms: platforms(settings) },
        });
        cookie = await signedIn(t);
      });

      afterAll(async () => {
        await t.deps.lifecycle.close();
      });

      it("hides X from the features", async () => {
        const response = await send(t.app, "GET", "/api/system/features", { cookie });
        expect(response.status).toBe(200);
        expect((await response.json()) as SystemFeatures).toEqual({ xPublishing: false });
      });

      it("blocks connecting an X account without creating a state", async () => {
        const before = await testDb.db.select().from(oauthStates);
        const started = await send(t.app, "GET", "/api/oauth/x/start", { cookie });
        expect(started.status).toBe(302);
        expect(started.headers.get("location")).toBe(
          "/settings/channels/connect?error=not_configured&provider=x",
        );
        expect(await testDb.db.select().from(oauthStates)).toHaveLength(before.length);
      });

      it("refuses a callback without calling X", async () => {
        const callback = await send(
          t.app,
          "GET",
          `/api/oauth/x/callback?${new URLSearchParams({
            code: fakeCredential("code"),
            state: fakeCredential("state"),
          })}`,
          { cookie },
        );
        expect(callback.status).toBe(302);
        expect(callback.headers.get("location")).toMatch(/error=(invalid_state|not_configured)/);
      });
    });
  }
});

describe("x sign-in with the flag on", () => {
  const app = fakeApp();
  let t: TestApp;
  let cookie: string;
  let mock: ReturnType<typeof installMockAgent>;

  beforeAll(async () => {
    t = createTestApp(testDb.db, {
      config: { encryption: keyring, platforms: platforms({ flag: true, app }) },
    });
    cookie = await signedIn(t);
    mock = installMockAgent();
  });

  afterAll(async () => {
    await mock.restore();
    await t.deps.lifecycle.close();
  });

  afterEach(() => {
    mock.agent.assertNoPendingInterceptors();
  });

  it("shows X in the features", async () => {
    const response = await send(t.app, "GET", "/api/system/features", { cookie });
    expect((await response.json()) as SystemFeatures).toEqual({ xPublishing: true });
  });

  it("signs in with PKCE, keeps the refresh token sealed and connects the account", async () => {
    const started = await send(t.app, "GET", "/api/oauth/x/start", { cookie });
    expect(started.status).toBe(302);
    const location = new URL(started.headers.get("location") ?? "");
    expect(`${location.origin}${location.pathname}`).toBe("https://x.com/i/oauth2/authorize");
    expect(location.searchParams.get("response_type")).toBe("code");
    expect(location.searchParams.get("client_id")).toBe(app.clientId);
    expect(location.searchParams.get("scope")).toBe(
      "tweet.read tweet.write users.read media.write offline.access",
    );
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    const redirectUri = `${REDIRECT_BASE}/api/oauth/x/callback`;
    expect(location.searchParams.get("redirect_uri")).toBe(redirectUri);
    const challenge = location.searchParams.get("code_challenge") ?? "";
    expect(challenge).toMatch(/^[\w-]{43}$/);
    const state = location.searchParams.get("state") ?? "";

    const code = fakeCredential("code");
    const accessToken = fakeCredential("access");
    const refreshToken = fakeCredential("refresh");
    const user = { id: fakeId(), name: "Loomcast", username: "loomcast" };
    const pool = mock.agent.get(API_ORIGIN);
    const seen: SeenRequest[] = [];
    answer(
      pool,
      "POST",
      "/2/oauth2/token",
      {
        body: {
          token_type: "bearer",
          access_token: accessToken,
          refresh_token: refreshToken,
          expires_in: 7_200,
          scope: "tweet.read tweet.write users.read media.write offline.access",
        },
      },
      seen,
    );
    answer(pool, "GET", "/2/users/me", { body: { data: user } }, seen);

    const callback = await send(
      t.app,
      "GET",
      `/api/oauth/x/callback?${new URLSearchParams({ code, state })}`,
      { cookie },
    );
    expect(callback.status).toBe(302);
    const target = new URL(callback.headers.get("location") ?? "", "https://app.invalid");
    const connection = target.searchParams.get("connection") ?? "";
    expect(connection).not.toBe("");

    const [exchange, me] = seen;
    const form = await formOf(exchange);
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code")).toBe(code);
    expect(form.get("redirect_uri")).toBe(redirectUri);
    const verifier = form.get("code_verifier") ?? "";
    expect(createHash("sha256").update(verifier, "ascii").digest("base64url")).toBe(challenge);
    expect(exchange?.headers.authorization).toBe(
      `Basic ${Buffer.from(`${app.clientId}:${app.clientSecret}`).toString("base64")}`,
    );
    expect(me?.headers.authorization).toBe(`Bearer ${accessToken}`);
    expect(me?.query.get("user.fields")).toBe("username,name,profile_image_url");

    const accepted = await send(t.app, "POST", `/api/oauth/connections/${connection}/accept`, {
      cookie,
      body: { accountIds: [`x:${user.id}`] },
    });
    expect(accepted.status).toBe(200);
    const text = await accepted.text();
    expect(text).not.toContain(accessToken);
    expect(text).not.toContain(refreshToken);
    const { channels: created } = JSON.parse(text) as { channels: Channel[] };
    expect(created[0]).toMatchObject({
      platform: "x",
      externalId: user.id,
      username: "loomcast",
      displayName: "Loomcast",
      connected: true,
      dryRun: true,
      tokenExpiresAt: new Date(t.clock.now().getTime() + 7_200_000).toISOString(),
    });

    const [row] = await testDb.db
      .select()
      .from(channels)
      .where(eq(channels.id, created[0]?.id ?? ""));
    const sealed = row === undefined ? null : sealedSecretOf(row);
    expect(sealed).not.toBeNull();
    if (sealed !== null) {
      expect(createVault(keyring).decrypt(sealed, channelAad(row?.id ?? ""))).toEqual({
        accessToken,
        refreshToken,
        provider: "x",
      });
    }
  });

  it("reports a refused code exchange as provider_error", async () => {
    const started = await send(t.app, "GET", "/api/oauth/x/start", { cookie });
    const state = new URL(started.headers.get("location") ?? "").searchParams.get("state") ?? "";
    answer(mock.agent.get(API_ORIGIN), "POST", "/2/oauth2/token", {
      status: 400,
      body: {
        error: "invalid_request",
        error_description: "Value passed for the code was invalid.",
      },
    });
    const callback = await send(
      t.app,
      "GET",
      `/api/oauth/x/callback?${new URLSearchParams({ code: fakeCredential("code"), state })}`,
      { cookie },
    );
    expect(callback.headers.get("location")).toBe(
      "/settings/channels/connect?error=provider_error&provider=x",
    );
  });
});
