import { createHmac, randomBytes } from "node:crypto";
import {
  type Channel,
  ChannelSchema,
  ConnectionCandidatesSchema,
  OAUTH_CONNECTION_TTL_MS,
  OAUTH_STATE_TTL_MS,
} from "@loomcast/contracts";
import { auditLog, channels, oauthConnections, oauthStates } from "@loomcast/db";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  channelAad,
  createVault,
  oauthConnectionAad,
  rotateVault,
  sealedSecretOf,
} from "../src/lib/vault";
import { ConnectionSecretSchema } from "../src/modules/oauth/types";
import {
  answer,
  createOAuthHarness,
  fakeCredential,
  fakeId,
  GRAPH_VERSION,
  graphError,
  type OAuthHarness,
  type SeenRequest,
} from "./oauth-support";
import { errorCode, send } from "./support";

let h: OAuthHarness;

beforeAll(async () => {
  h = await createOAuthHarness();
});

afterAll(async () => {
  await h.close();
});

afterEach(() => {
  h.agent.assertNoPendingInterceptors();
});

function meta() {
  if (h.meta === null) {
    throw new Error("the harness has no Meta app");
  }
  return h.meta;
}

function proofOf(token: string): string {
  return createHmac("sha256", meta().appSecret).update(token).digest("hex");
}

function get(path: string, cookie = h.cookie): Promise<Response> {
  return send(h.t.app, "GET", path, { cookie });
}

/** Starts a Meta sign-in and returns the state the dialog URL carries. */
async function start(cookie = h.cookie, query = ""): Promise<{ state: string; location: URL }> {
  const response = await get(`/api/oauth/meta/start${query}`, cookie);
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get("location") ?? "");
  const state = location.searchParams.get("state");
  if (state === null) {
    throw new Error(`no state in ${location.origin}${location.pathname}`);
  }
  return { state, location };
}

function callback(params: Record<string, string>, cookie = h.cookie): Promise<Response> {
  return get(`/api/oauth/meta/callback?${new URLSearchParams(params).toString()}`, cookie);
}

/** The connect page outcome a callback redirected to. */
function outcome(response: Response): Record<string, string> {
  expect(response.status).toBe(302);
  const location = response.headers.get("location") ?? "";
  expect(location.startsWith("/settings/channels/connect?")).toBe(true);
  return Object.fromEntries(new URL(location, "https://app.invalid").searchParams);
}

interface Page {
  id: string;
  name: string;
  token: string;
  ig?: { id: string; username: string };
}

function fakePage(withInstagram = true): Page {
  return {
    id: fakeId(),
    name: `Page ${fakeId()}`,
    token: fakeCredential("page"),
    ...(withInstagram ? { ig: { id: fakeId(), username: `ig_${fakeId()}` } } : {}),
  };
}

interface Exchange {
  code: string;
  shortToken: string;
  longToken: string;
  seen: SeenRequest[];
}

/** Answers the code exchange, the long-lived exchange, the token check and the Page list. */
function answerSignIn(pages: Page[], scopes = ["pages_show_list", "pages_manage_posts"]): Exchange {
  const exchange: Exchange = {
    code: fakeCredential("code"),
    shortToken: fakeCredential("short"),
    longToken: fakeCredential("long"),
    seen: [],
  };
  answer(
    h.graph,
    "GET",
    `/${GRAPH_VERSION}/oauth/access_token`,
    { body: { access_token: exchange.shortToken, token_type: "bearer", expires_in: 3600 } },
    exchange.seen,
  );
  answer(
    h.graph,
    "GET",
    `/${GRAPH_VERSION}/oauth/access_token`,
    { body: { access_token: exchange.longToken, token_type: "bearer", expires_in: 5_183_944 } },
    exchange.seen,
  );
  answer(
    h.graph,
    "GET",
    `/${GRAPH_VERSION}/debug_token`,
    { body: { data: { app_id: meta().appId, is_valid: true, scopes, user_id: fakeId() } } },
    exchange.seen,
  );
  answer(
    h.graph,
    "GET",
    `/${GRAPH_VERSION}/me/accounts`,
    {
      body: {
        data: pages.map((page) => ({
          id: page.id,
          name: page.name,
          access_token: page.token,
          ...(page.ig === undefined
            ? {}
            : { instagram_business_account: { id: page.ig.id, username: page.ig.username } }),
        })),
        paging: { cursors: { before: "b", after: "a" } },
      },
      headers: {
        "x-app-usage": JSON.stringify({ call_count: 3, total_time: 1, total_cputime: 1 }),
      },
    },
    exchange.seen,
  );
  return exchange;
}

/** Runs a whole sign-in and returns the pending connection id. */
async function signIn(pages: Page[]): Promise<{ connection: string; exchange: Exchange }> {
  const { state } = await start();
  const exchange = answerSignIn(pages);
  const result = outcome(await callback({ code: exchange.code, state }));
  expect(result).toMatchObject({ provider: "meta" });
  if (result.connection === undefined) {
    throw new Error(`sign-in failed: ${result.error}`);
  }
  return { connection: result.connection, exchange };
}

function accept(connection: string, accountIds: string[], cookie = h.cookie): Promise<Response> {
  return send(h.t.app, "POST", `/api/oauth/connections/${connection}/accept`, {
    cookie,
    body: { accountIds },
  });
}

async function channelRow(id: string) {
  const [row] = await h.db.select().from(channels).where(eq(channels.id, id));
  if (row === undefined) {
    throw new Error("no channel");
  }
  return row;
}

describe("meta sign-in", () => {
  it("redirects to the login dialog with the configuration and a hashed single-use state", async () => {
    const { state, location } = await start(h.cookie, "?redirectTo=%2Fsettings%2Fchannels");
    expect(`${location.origin}${location.pathname}`).toBe(
      `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth`,
    );
    expect(location.searchParams.get("client_id")).toBe(meta().appId);
    expect(location.searchParams.get("config_id")).toBe(meta().loginConfigId);
    expect(location.searchParams.get("response_type")).toBe("code");
    expect(location.searchParams.get("redirect_uri")).toBe(
      "https://loomcast.example.test/api/oauth/meta/callback",
    );
    expect(Buffer.from(state, "base64url")).toHaveLength(32);
    const rows = await h.db.select().from(oauthStates).where(eq(oauthStates.userId, h.userId));
    const row = rows.find((candidate) => candidate.redirectTo === "/settings/channels");
    expect(row).toMatchObject({ provider: "meta", usedAt: null });
    expect(row?.stateHash).not.toBe(state);
    expect((row?.expiresAt.getTime() ?? 0) - (row?.createdAt.getTime() ?? 0)).toBe(
      OAUTH_STATE_TTL_MS,
    );
  });

  it("exchanges the code, lists the Pages and keeps the tokens sealed in a connection", async () => {
    const pages = [fakePage(), fakePage(false)];
    const { connection, exchange } = await signIn(pages);

    const [codeExchange, longExchange, debug, accounts] = exchange.seen;
    expect(codeExchange?.query.get("code")).toBe(exchange.code);
    expect(codeExchange?.query.get("client_id")).toBe(meta().appId);
    expect(codeExchange?.query.get("client_secret")).toBe(meta().appSecret);
    expect(codeExchange?.query.get("redirect_uri")).toBe(
      "https://loomcast.example.test/api/oauth/meta/callback",
    );
    expect(longExchange?.query.get("grant_type")).toBe("fb_exchange_token");
    expect(longExchange?.query.get("fb_exchange_token")).toBe(exchange.shortToken);
    expect(debug?.query.get("input_token")).toBe(exchange.longToken);
    const appToken = `${meta().appId}|${meta().appSecret}`;
    expect(debug?.headers.authorization).toBe(`Bearer ${appToken}`);
    expect(debug?.query.get("appsecret_proof")).toBe(proofOf(appToken));
    expect(accounts?.headers.authorization).toBe(`Bearer ${exchange.longToken}`);
    expect(accounts?.query.get("appsecret_proof")).toBe(proofOf(exchange.longToken));
    expect(accounts?.query.get("fields")).toBe(
      "id,name,access_token,instagram_business_account{id,username}",
    );

    const [row] = await h.db
      .select()
      .from(oauthConnections)
      .where(eq(oauthConnections.id, connection));
    expect(row?.secretCiphertext).not.toBeNull();
    expect(JSON.stringify(row?.candidates)).not.toContain(pages[0]?.token ?? "?");

    const response = await get(`/api/oauth/connections/${connection}`);
    expect(response.status).toBe(200);
    const text = await response.text();
    for (const secret of [exchange.longToken, exchange.shortToken, pages[0]?.token ?? "?"]) {
      expect(text).not.toContain(secret);
    }
    const body = ConnectionCandidatesSchema.parse(JSON.parse(text));
    expect(body.provider).toBe("meta");
    expect(new Date(body.expiresAt).getTime() - h.t.clock.now().getTime()).toBe(
      OAUTH_CONNECTION_TTL_MS,
    );
    expect(body.accounts).toEqual([
      {
        id: `facebook:${pages[0]?.id}`,
        platform: "facebook",
        externalId: pages[0]?.id,
        name: pages[0]?.name,
        parentId: null,
        alreadyConnected: false,
      },
      {
        id: `instagram:${pages[0]?.ig?.id}`,
        platform: "instagram",
        externalId: pages[0]?.ig?.id,
        name: pages[0]?.ig?.username,
        username: pages[0]?.ig?.username,
        parentId: `facebook:${pages[0]?.id}`,
        alreadyConnected: false,
      },
      {
        id: `facebook:${pages[1]?.id}`,
        platform: "facebook",
        externalId: pages[1]?.id,
        name: pages[1]?.name,
        parentId: null,
        alreadyConnected: false,
      },
    ]);
  });

  it("accepting an Instagram account connects it and its Page, active and in dry-run", async () => {
    const page = fakePage();
    const { connection } = await signIn([page]);
    const response = await accept(connection, [`instagram:${page.ig?.id}`]);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain(page.token);
    const { channels: created } = JSON.parse(text) as { channels: Channel[] };
    expect(created.map((channel) => ChannelSchema.parse(channel).platform)).toEqual([
      "facebook",
      "instagram",
    ]);
    const [fb, ig] = created;
    expect(fb).toMatchObject({
      externalId: page.id,
      displayName: page.name,
      status: "active",
      dryRun: true,
      connected: true,
      parentChannelId: null,
      scopes: ["pages_show_list", "pages_manage_posts"],
      tokenExpiresAt: null,
    });
    expect(ig).toMatchObject({
      externalId: page.ig?.id,
      username: page.ig?.username,
      status: "active",
      dryRun: true,
      connected: true,
      parentChannelId: fb?.id,
    });

    // Both channels publish with the Page token, sealed per channel.
    const vault = createVault(h.t.deps.config.encryption ?? fail());
    for (const channel of [fb, ig]) {
      const row = await channelRow(channel?.id ?? "");
      const sealed = sealedSecretOf(row);
      expect(sealed).not.toBeNull();
      if (sealed !== null) {
        expect(vault.decrypt(sealed, channelAad(row.id))).toMatchObject({
          accessToken: page.token,
          provider: "meta",
        });
      }
    }
    const igRow = await channelRow(ig?.id ?? "");
    const igSealed = sealedSecretOf(igRow);
    expect(igSealed === null ? null : vault.decrypt(igSealed, channelAad(igRow.id))).toMatchObject({
      pageId: page.id,
    });

    const actions = await h.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.targetId, fb?.id ?? ""));
    expect(actions.map((row) => row.action)).toEqual(["channel.connected"]);
    expect(JSON.stringify(actions)).not.toContain(page.token);
    expect(
      h.live.filter(
        (event) => event.type === "channel.updated" && event.payload.channel.id === ig?.id,
      ),
    ).toHaveLength(1);

    // The connection is used up and its tokens are gone.
    const [used] = await h.db
      .select()
      .from(oauthConnections)
      .where(eq(oauthConnections.id, connection));
    expect(used?.consumedAt).not.toBeNull();
    expect(used?.secretCiphertext).toBeNull();
    expect(await errorCode(await accept(connection, [`facebook:${page.id}`]))).toBe(
      "connection_expired",
    );
    const again = await get(`/api/oauth/connections/${connection}`);
    expect(again.status).toBe(410);
  });

  it("marks connected accounts and reconnects them instead of adding channels", async () => {
    const page = fakePage(false);
    const first = await signIn([page]);
    const created = (await (await accept(first.connection, [`facebook:${page.id}`])).json()) as {
      channels: Channel[];
    };
    const channelId = created.channels[0]?.id ?? "";
    await h.db
      .update(channels)
      .set({
        status: "needs_reauth",
        displayName: "Renamed",
        lastError: { code: "auth", retryable: false, message: "Token expired" },
      })
      .where(eq(channels.id, channelId));

    page.token = fakeCredential("page");
    const second = await signIn([page]);
    const listed = ConnectionCandidatesSchema.parse(
      await (await get(`/api/oauth/connections/${second.connection}`)).json(),
    );
    expect(listed.accounts[0]?.alreadyConnected).toBe(true);
    const response = await accept(second.connection, [`facebook:${page.id}`]);
    expect(response.status).toBe(200);
    const { channels: reconnected } = (await response.json()) as { channels: Channel[] };
    expect(reconnected[0]).toMatchObject({
      id: channelId,
      displayName: "Renamed",
      status: "active",
      lastError: null,
    });
    const row = await channelRow(channelId);
    const vault = createVault(h.t.deps.config.encryption ?? fail());
    const sealed = sealedSecretOf(row);
    expect(sealed === null ? null : vault.decrypt(sealed, channelAad(channelId))).toMatchObject({
      accessToken: page.token,
    });
    const actions = await h.db.select().from(auditLog).where(eq(auditLog.targetId, channelId));
    expect(actions.map((entry) => entry.action)).toEqual([
      "channel.connected",
      "channel.reconnected",
    ]);
  });

  it("refuses a replayed state", async () => {
    const { state } = await start();
    const exchange = answerSignIn([fakePage()]);
    expect(outcome(await callback({ code: exchange.code, state })).connection).toBeDefined();
    expect(outcome(await callback({ code: exchange.code, state }))).toEqual({
      error: "invalid_state",
      provider: "meta",
    });
  });

  it("refuses an expired state", async () => {
    const { state } = await start();
    h.t.clock.advance(OAUTH_STATE_TTL_MS + 1_000);
    try {
      expect(outcome(await callback({ code: fakeCredential("code"), state }))).toEqual({
        error: "invalid_state",
        provider: "meta",
      });
    } finally {
      h.t.clock.advance(-(OAUTH_STATE_TTL_MS + 1_000));
    }
  });

  it("refuses a state started by another user, without using it up", async () => {
    const other = await h.otherUser();
    const { state } = await start();
    expect(outcome(await callback({ code: fakeCredential("code"), state }, other.cookie))).toEqual({
      error: "invalid_state",
      provider: "meta",
    });
    const exchange = answerSignIn([fakePage()]);
    const { connection } = outcome(await callback({ code: exchange.code, state }));
    expect(connection).toBeDefined();
    // Nor may the other user read or accept the connection.
    expect((await get(`/api/oauth/connections/${connection}`, other.cookie)).status).toBe(404);
    expect((await accept(connection ?? "", ["facebook:1"], other.cookie)).status).toBe(404);
  });

  it("refuses a state of another provider and a callback without code or state", async () => {
    const { state } = await start();
    const threads = await get(
      `/api/oauth/threads/callback?${new URLSearchParams({ code: fakeCredential("code"), state })}`,
    );
    expect(outcome(threads)).toEqual({ error: "invalid_state", provider: "threads" });
    expect(outcome(await callback({ state }))).toEqual({
      error: "invalid_state",
      provider: "meta",
    });
  });

  it("sends a declined sign-in back with access_denied and uses up its state", async () => {
    const { state } = await start();
    const declined = await callback({
      error: "access_denied",
      error_reason: "user_denied",
      error_description: "Permissions error.",
      state,
    });
    expect(outcome(declined)).toEqual({ error: "access_denied", provider: "meta" });
    expect(outcome(await callback({ code: fakeCredential("code"), state }))).toEqual({
      error: "invalid_state",
      provider: "meta",
    });
  });

  it("reports a refused exchange as provider_error and an empty Page list as no_accounts", async () => {
    const first = await start();
    answer(h.graph, "GET", `/${GRAPH_VERSION}/oauth/access_token`, {
      status: 400,
      body: graphError(100, "Invalid verification code format."),
    });
    expect(outcome(await callback({ code: fakeCredential("code"), state: first.state }))).toEqual({
      error: "provider_error",
      provider: "meta",
    });

    const second = await start();
    const exchange = answerSignIn([]);
    expect(outcome(await callback({ code: exchange.code, state: second.state }))).toEqual({
      error: "no_accounts",
      provider: "meta",
    });
  });

  it("validates accepted account ids and expires pending connections", async () => {
    const page = fakePage(false);
    const { connection } = await signIn([page]);
    expect(await errorCode(await accept(connection, ["facebook:unknown"]))).toBe(
      "validation_failed",
    );
    h.t.clock.advance(OAUTH_CONNECTION_TTL_MS + 1_000);
    try {
      expect(await errorCode(await accept(connection, [`facebook:${page.id}`]))).toBe(
        "connection_expired",
      );
    } finally {
      h.t.clock.advance(-(OAUTH_CONNECTION_TTL_MS + 1_000));
    }
    expect((await get("/api/oauth/connections/00000000-0000-4000-8000-000000000000")).status).toBe(
      404,
    );
  });

  it("disconnecting wipes the credentials and keeps the channel", async () => {
    const page = fakePage(false);
    const { connection } = await signIn([page]);
    const { channels: created } = (await (
      await accept(connection, [`facebook:${page.id}`])
    ).json()) as { channels: Channel[] };
    const id = created[0]?.id ?? "";
    const response = await send(h.t.app, "DELETE", `/api/channels/${id}/connection`, {
      cookie: h.cookie,
    });
    expect(response.status).toBe(200);
    expect(ChannelSchema.parse(await response.json())).toMatchObject({
      id,
      status: "disconnected",
      connected: false,
      dryRun: true,
      externalId: page.id,
      scopes: [],
      liveBlocker: "not_connected",
    });
    const row = await channelRow(id);
    expect([row.secretCiphertext, row.secretNonce, row.keyVersion]).toEqual([null, null, null]);
    const actions = await h.db.select().from(auditLog).where(eq(auditLog.targetId, id));
    expect(actions.map((entry) => entry.action)).toContain("channel.disconnected");
    expect(
      (
        await send(
          h.t.app,
          "DELETE",
          "/api/channels/00000000-0000-4000-8000-000000000000/connection",
          {
            cookie: h.cookie,
          },
        )
      ).status,
    ).toBe(404);
  });

  // Runs last among the flows: afterwards the app's own key no longer opens the rows.
  it("key rotation seals pending connections again with the new key", async () => {
    const page = fakePage(false);
    const { connection } = await signIn([page]);
    const current = h.t.deps.config.encryption ?? fail();
    const next = createVault({
      keyVersion: current.keyVersion + 1,
      key: randomBytes(32),
      previousKeys: new Map([[current.keyVersion, current.key]]),
    });
    const result = await rotateVault(h.db, next);
    expect(result.reencrypted).toBe(result.rows);
    const [row] = await h.db
      .select()
      .from(oauthConnections)
      .where(eq(oauthConnections.id, connection));
    expect(row?.keyVersion).toBe(current.keyVersion + 1);
    const sealed = row === undefined ? null : sealedSecretOf(row);
    const secret = ConnectionSecretSchema.parse(
      sealed === null ? {} : next.decrypt(sealed, oauthConnectionAad(connection)),
    );
    expect(secret.accounts[`facebook:${page.id}`]?.accessToken).toBe(page.token);
  });

  it("never writes a token, code or secret to the log", () => {
    const logs = h.t.logs.join("\n");
    expect(logs).not.toContain(meta().appSecret);
    expect(logs).not.toMatch(/(short|long|page|code)-[0-9a-f]{32}/);
  });
});

describe("unconfigured providers", () => {
  it("sends start and the features endpoint back with not_configured and no X", async () => {
    const response = await get("/api/oauth/x/start");
    expect(outcome(response)).toEqual({ error: "not_configured", provider: "x" });
    const features = await get("/api/system/features");
    expect(await features.json()).toEqual({ xPublishing: false });
    expect((await get("/api/oauth/unknown/start")).status).toBe(404);
  });

  it("requires a session", async () => {
    const response = await send(h.t.app, "GET", "/api/oauth/meta/start");
    expect(response.status).toBe(401);
  });
});

function fail(): never {
  throw new Error("missing value");
}
