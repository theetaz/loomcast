import { candidateAccountId } from "@loomcast/contracts";
import {
  createThreadsGraphClient,
  exchangeThreadsCode,
  exchangeThreadsLongLivedToken,
  getThreadsProfile,
  THREADS_SCOPES,
  threadsAuthorizeUrl,
} from "../../lib/meta-graph";
import { candidateName, candidateUsername } from "./names";
import type { OAuthProviderFactory } from "./types";

/**
 * The Threads sign-in: the authorization window, the code exchanged for a short-lived token and
 * then a long-lived one (60 days, refreshed by `channel.refresh_token`), and the profile it
 * belongs to, the only candidate.
 */
export const threadsProvider: OAuthProviderFactory = ({ platforms, fetch }) => {
  const client = createThreadsGraphClient(platforms, fetch === undefined ? {} : { fetch });
  return {
    provider: "threads",
    usesPkce: false,
    available: () => platforms.threads !== null,

    authorizeUrl({ state, redirectUri }) {
      if (platforms.threads === null) {
        throw new Error("the Threads app is not configured");
      }
      return threadsAuthorizeUrl(platforms.threads, { redirectUri, state });
    },

    async complete({ code, redirectUri, signal, now }) {
      const app = platforms.threads;
      if (app === null) {
        throw new Error("the Threads app is not configured");
      }
      const short = await exchangeThreadsCode(client, app, { code, redirectUri, signal });
      const long = await exchangeThreadsLongLivedToken(client, app, {
        accessToken: short.access_token,
        signal,
      });
      const profile = await getThreadsProfile(client, { accessToken: long.access_token, signal });
      const id = candidateAccountId("threads", profile.id);
      const username = candidateUsername(profile.username);
      return {
        candidates: [
          {
            id,
            platform: "threads",
            externalId: profile.id,
            name: candidateName(profile.username, `Threads ${profile.id}`),
            ...(username === undefined ? {} : { username }),
            parentId: null,
          },
        ],
        secret: {
          accounts: {
            [id]: {
              accessToken: long.access_token,
              tokenExpiresAt: new Date(now.getTime() + long.expires_in * 1000).toISOString(),
              scopes: [...THREADS_SCOPES],
              extra: {},
            },
          },
        },
      };
    },
  };
};
