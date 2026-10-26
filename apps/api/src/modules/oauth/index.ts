import { randomUUID } from "node:crypto";
import {
  AcceptConnectionSchema,
  type CandidateAccount,
  CandidateAccountIdSchema,
  type ConnectionCandidates,
  candidateAccountId,
  connectionPicturePath,
  OAUTH_CONNECT_PAGE_PATH,
  OAUTH_CONNECTION_TTL_MS,
  OAuthCallbackQuerySchema,
  type OAuthConnectError,
  type OAuthProvider,
  OAuthProviderSchema,
  OAuthStartQuerySchema,
  routes,
  type SystemFeatures,
} from "@loomcast/contracts";
import { channels, oauthConnections } from "@loomcast/db";
import { and, eq, or } from "drizzle-orm";
import { type Context, Hono } from "hono";
import type { ModuleDeps } from "../../deps";
import { audit } from "../../lib/audit";
import { transaction } from "../../lib/db";
import { HttpError, notFound, validationFailed } from "../../lib/errors";
import { clientIp, idParam, readJson } from "../../lib/http";
import { MetaGraphError } from "../../lib/meta-graph";
import { fetchPicture, pictureResponse } from "../../lib/pictures";
import { oauthConnectionAad } from "../../lib/vault";
import type { AppEnv } from "../../types";
import { currentUser } from "../auth/guards";
import { requireActiveWorkspace } from "../kb/service";
import { acceptConnection, connectionExpired, withParents } from "./accept";
import { createOAuthProviders, type OAuthProviders } from "./providers";
import { oauthRedirectUri } from "./redirect";
import { consumeState, createOAuthState } from "./state";
import type { OAuthProviderAdapter } from "./types";

export { createOAuthProviders, type OAuthProviders, oauthProviderFactories } from "./providers";
export { oauthRedirectUri } from "./redirect";
export type * from "./types";

const connectionNotFound = () => notFound("No pending connection has that id.");

/** The connect page with `?connection=` or `?error=`, as a path on the app. */
export function connectPageLocation(
  provider: OAuthProvider,
  outcome: { connection: string } | { error: OAuthConnectError },
): string {
  const search = new URLSearchParams();
  if ("connection" in outcome) {
    search.set("connection", outcome.connection);
  } else {
    search.set("error", outcome.error);
  }
  search.set("provider", provider);
  return `${OAUTH_CONNECT_PAGE_PATH}?${search.toString()}`;
}

function redirect(c: Context<AppEnv>, location: string): Response {
  c.header("Cache-Control", "no-store");
  return c.redirect(location, 302);
}

/**
 * Connecting channels through the platforms' sign-ins, and the server's feature flags.
 *
 * - `oauth.start` creates a single-use state bound to the user and redirects to the platform.
 * - `oauth.callback` consumes the state, exchanges the code for long-lived credentials, keeps them
 *   sealed in a pending connection with the accounts they can publish as, and redirects to the
 *   connect page. Failures redirect there with `?error=`.
 * - `oauth.connection` lists the accounts (never the credentials) and `oauth.connectionPicture`
 *   passes their profile pictures through; `oauth.accept` consumes the connection and creates or
 *   reconnects the chosen channels.
 *
 * Codes, tokens and secrets are never logged, audited or returned.
 */
export function register(app: Hono<AppEnv>, deps: ModuleDeps): Hono<AppEnv> {
  const { db, vault, clock, config } = deps;
  const providers: OAuthProviders = createOAuthProviders({ platforms: config.platforms });
  const router = new Hono<AppEnv>();

  /** The provider of the path, when the server can use it and can seal credentials. */
  function usable(provider: OAuthProvider): OAuthProviderAdapter | null {
    const adapter = providers[provider];
    return adapter?.available() && vault.configured ? adapter : null;
  }

  function providerParam(c: Context<AppEnv>): OAuthProvider {
    const parsed = OAuthProviderSchema.safeParse(c.req.param("provider"));
    if (!parsed.success) {
      throw notFound();
    }
    return parsed.data;
  }

  router.get(routes["system.features"].path, (c) => {
    currentUser(c);
    const features: SystemFeatures = { xPublishing: providers.x?.available() ?? false };
    c.header("Cache-Control", "no-store");
    return c.json(features, 200);
  });

  router.get(routes["oauth.start"].path, async (c) => {
    const user = currentUser(c);
    const provider = providerParam(c);
    const adapter = usable(provider);
    if (adapter === null) {
      return redirect(c, connectPageLocation(provider, { error: "not_configured" }));
    }
    // A malformed `redirectTo` is dropped rather than refused: this is a page navigation.
    const query = OAuthStartQuerySchema.safeParse(c.req.query());
    const { state, codeChallenge } = await createOAuthState(db, vault, {
      provider,
      userId: user.id,
      redirectTo: query.success ? (query.data.redirectTo ?? null) : null,
      usesPkce: adapter.usesPkce,
      now: clock.now(),
    });
    const location = adapter.authorizeUrl({
      state,
      redirectUri: oauthRedirectUri(config.platforms.redirectBase, provider),
      codeChallenge,
    });
    return redirect(c, location);
  });

  router.get(routes["oauth.callback"].path, async (c) => {
    const user = currentUser(c);
    const provider = providerParam(c);
    const log = c.get("logger");
    const fail = (error: OAuthConnectError) =>
      redirect(c, connectPageLocation(provider, { error }));

    const query = OAuthCallbackQuerySchema.safeParse(c.req.query());
    if (!query.success) {
      return fail("invalid_state");
    }
    const { code, state, error } = query.data;
    const now = clock.now();
    if (error !== undefined) {
      // A declined sign-in still uses up its state, so the URL cannot be replayed.
      if (state !== undefined && state !== "") {
        await consumeState(db, vault, { state, provider, userId: user.id, now });
      }
      log.info({ provider, reason: error.slice(0, 64) }, "oauth sign-in declined");
      return fail(error === "access_denied" ? "access_denied" : "provider_error");
    }
    if (code === undefined || code === "" || state === undefined || state === "") {
      return fail("invalid_state");
    }
    const consumed = await consumeState(db, vault, { state, provider, userId: user.id, now });
    if (consumed === null) {
      log.warn({ provider }, "oauth callback with an invalid, expired or replayed state");
      return fail("invalid_state");
    }
    const adapter = usable(provider);
    if (adapter === null) {
      return fail("not_configured");
    }

    let result: Awaited<ReturnType<OAuthProviderAdapter["complete"]>>;
    try {
      result = await adapter.complete({
        code,
        redirectUri: oauthRedirectUri(config.platforms.redirectBase, provider),
        codeVerifier: consumed.codeVerifier,
        now,
      });
    } catch (failure) {
      if (failure instanceof MetaGraphError) {
        log.warn({ provider, failure: failure.toLog() }, "oauth code exchange failed");
        return fail("provider_error");
      }
      throw failure;
    }
    if (result.candidates.length === 0) {
      log.info({ provider }, "oauth sign-in offers no account");
      return fail("no_accounts");
    }

    const connectionId = randomUUID();
    let sealed: ReturnType<typeof vault.encrypt>;
    try {
      sealed = vault.encrypt(result.secret, oauthConnectionAad(connectionId));
    } catch (failure) {
      if (failure instanceof HttpError) {
        return fail("not_configured");
      }
      throw failure;
    }
    await transaction(db, async (tx) => {
      await tx.insert(oauthConnections).values({
        id: connectionId,
        provider,
        userId: user.id,
        ...sealed,
        candidates: result.candidates,
        expiresAt: new Date(now.getTime() + OAUTH_CONNECTION_TTL_MS),
        createdAt: now,
      });
      await audit(tx, {
        actorKind: "user",
        actorId: user.id,
        action: "oauth.connection.created",
        targetType: "oauth_connection",
        targetId: connectionId,
        data: { provider, accounts: result.candidates.length },
        ip: clientIp(c, config.trustProxy),
      });
    });
    return redirect(c, connectPageLocation(provider, { connection: connectionId }));
  });

  /** The pending connection `id` of `userId`: 404 for none or another user's, 410 once over. */
  async function pendingConnection(id: string, userId: string) {
    const [row] = await db
      .select({
        id: oauthConnections.id,
        provider: oauthConnections.provider,
        userId: oauthConnections.userId,
        candidates: oauthConnections.candidates,
        expiresAt: oauthConnections.expiresAt,
        consumedAt: oauthConnections.consumedAt,
      })
      .from(oauthConnections)
      .where(eq(oauthConnections.id, id));
    if (row === undefined || row.userId !== userId) {
      throw connectionNotFound();
    }
    if (row.consumedAt !== null || row.expiresAt.getTime() <= clock.now().getTime()) {
      throw connectionExpired();
    }
    return row;
  }

  router.get(routes["oauth.connection"].path, async (c) => {
    const user = currentUser(c);
    const id = idParam(c);
    const row = await pendingConnection(id, user.id);
    const known = new Set<string>();
    if (row.candidates.length > 0) {
      const existing = await db
        .select({ platform: channels.platform, externalId: channels.externalId })
        .from(channels)
        .where(
          or(
            ...row.candidates.map((candidate) =>
              and(
                eq(channels.platform, candidate.platform),
                eq(channels.externalId, candidate.externalId),
              ),
            ),
          ),
        );
      for (const channel of existing) {
        if (channel.externalId !== null) {
          known.add(candidateAccountId(channel.platform, channel.externalId));
        }
      }
    }
    const accounts: CandidateAccount[] = row.candidates.map(({ picture, ...candidate }) => ({
      ...candidate,
      alreadyConnected: known.has(candidateAccountId(candidate.platform, candidate.externalId)),
      pictureUrl: picture === undefined ? null : connectionPicturePath(row.id, candidate.id),
    }));
    const body: ConnectionCandidates = {
      id: row.id,
      provider: row.provider,
      expiresAt: row.expiresAt.toISOString(),
      accounts,
    };
    c.header("Cache-Control", "no-store");
    return c.json(body, 200);
  });

  router.get(routes["oauth.connectionPicture"].path, async (c) => {
    const user = currentUser(c);
    const id = idParam(c);
    const accountId = CandidateAccountIdSchema.safeParse(c.req.param("accountId"));
    if (!accountId.success) {
      throw notFound();
    }
    const row = await pendingConnection(id, user.id);
    const picture = row.candidates.find((candidate) => candidate.id === accountId.data)?.picture;
    const fetched =
      picture === undefined ? null : await fetchPicture(picture, { signal: c.req.raw.signal });
    if (fetched === null) {
      throw notFound("That account has no picture.");
    }
    return pictureResponse(fetched);
  });

  router.post(routes["oauth.accept"].path, async (c) => {
    const user = currentUser(c);
    const id = idParam(c);
    const input = await readJson(c, AcceptConnectionSchema);
    const row = await pendingConnection(id, user.id);
    const known = new Set(row.candidates.map((candidate) => candidate.id));
    const unknown = input.accountIds.flatMap((accountId, index) =>
      known.has(accountId)
        ? []
        : [{ path: `accountIds.${index}`, message: "No account of this connection has that id" }],
    );
    if (unknown.length > 0) {
      throw validationFailed(unknown);
    }
    const accounts = withParents(row.candidates, input.accountIds);
    const result = await transaction(db, async (tx) => {
      await requireActiveWorkspace(tx, input.workspaceId);
      return acceptConnection(tx, deps, {
        connectionId: id,
        workspaceId: input.workspaceId,
        userId: user.id,
        provider: row.provider,
        accounts,
        ip: clientIp(c, config.trustProxy),
        now: clock.now(),
      });
    });
    return c.json({ channels: result }, 200);
  });

  app.route("/", router);
  return router;
}
