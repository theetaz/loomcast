import { candidateAccountId } from "@loomcast/contracts";
import { XApiError } from "../publisher/adapters/x/client";
import { usableXApp, xClientFor } from "../publisher/adapters/x/config";
import { exchangeXCode, getXUser, xAuthorizeUrl } from "../publisher/adapters/x/oauth";
import { publishError } from "../publisher/errors";
import { candidateName, candidateUsername } from "./names";
import type { OAuthProviderFactory } from "./types";

/**
 * The X sign-in: OAuth 2.0 with PKCE (S256; the verifier is sealed in `oauth_states`), the code
 * exchanged for a two-hour access token and a refresh token (`offline.access`), and the signed-in
 * user, the only candidate. The refresh token is kept in the channel's sealed secret next to the
 * access token. Behind `FEATURE_X_PUBLISHING`: while the flag is off the provider is unavailable,
 * so the start redirects to `not_configured`, and nothing here ever calls X.
 */
export const xProvider: OAuthProviderFactory = ({ platforms, fetch }) => {
  const client = xClientFor(platforms, { fetch });
  return {
    provider: "x",
    usesPkce: true,
    available: () => usableXApp(platforms) !== null,

    authorizeUrl({ state, redirectUri, codeChallenge }) {
      const app = usableXApp(platforms);
      if (app === null) {
        throw new Error("X publishing is off or the X app is not configured");
      }
      if (codeChallenge === null) {
        throw new Error("the X sign-in needs a PKCE challenge");
      }
      return xAuthorizeUrl(app, { redirectUri, state, codeChallenge });
    },

    async complete({ code, redirectUri, codeVerifier, signal, now }) {
      const app = usableXApp(platforms);
      if (app === null) {
        throw new Error("X publishing is off or the X app is not configured");
      }
      if (codeVerifier === null) {
        throw new XApiError(
          publishError("auth", "The sign-in lost its PKCE verifier; start again.", {
            retryable: false,
          }),
          { status: null },
        );
      }
      const pair = await exchangeXCode(client, app, {
        code,
        redirectUri,
        codeVerifier,
        now,
        signal,
      });
      const user = await getXUser(client, { accessToken: pair.accessToken, signal });
      const id = candidateAccountId("x", user.id);
      const username = candidateUsername(user.username);
      return {
        candidates: [
          {
            id,
            platform: "x",
            externalId: user.id,
            name: candidateName(user.name ?? user.username, `X ${user.id}`),
            ...(username === undefined ? {} : { username }),
            parentId: null,
          },
        ],
        secret: {
          accounts: {
            [id]: {
              accessToken: pair.accessToken,
              tokenExpiresAt: pair.expiresAt.toISOString(),
              scopes: pair.scopes,
              extra: { refreshToken: pair.refreshToken },
            },
          },
        },
      };
    },
  };
};
