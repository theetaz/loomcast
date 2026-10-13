import { candidateAccountId, MAX_CONNECTION_ACCOUNTS } from "@loomcast/contracts";
import type { OAuthCandidateRow } from "@loomcast/db";
import {
  createMetaGraphClient,
  debugMetaToken,
  exchangeMetaCode,
  exchangeMetaLongLivedToken,
  listMetaPages,
  MetaGraphError,
  metaDialogUrl,
} from "../../lib/meta-graph";
import { pictureUrlOf } from "../../lib/pictures";
import { candidateName, candidateUsername } from "./names";
import type { ConnectionSecret, OAuthProviderFactory } from "./types";

/**
 * Facebook Login for Business: the dialog with the login configuration, the code exchanged for a
 * long-lived user token, then the user's Pages, each with its own Page token and its linked
 * Instagram professional account. Every Page becomes a Facebook candidate and every linked
 * Instagram account an Instagram candidate whose parent is the Page: both publish with the Page
 * token, which does not expire. Each keeps its profile picture address, when it has one.
 */
export const metaProvider: OAuthProviderFactory = ({ platforms, fetch }) => {
  const client = createMetaGraphClient(platforms, fetch === undefined ? {} : { fetch });
  return {
    provider: "meta",
    usesPkce: false,
    available: () => platforms.meta !== null,

    authorizeUrl({ state, redirectUri }) {
      if (platforms.meta === null) {
        throw new Error("the Meta app is not configured");
      }
      return metaDialogUrl(platforms.meta, {
        version: platforms.metaGraphVersion,
        redirectUri,
        state,
      });
    },

    async complete({ code, redirectUri, signal }) {
      const app = platforms.meta;
      if (app === null) {
        throw new Error("the Meta app is not configured");
      }
      const short = await exchangeMetaCode(client, app, { code, redirectUri, signal });
      const long = await exchangeMetaLongLivedToken(client, app, {
        accessToken: short.access_token,
        signal,
      });
      let scopes: string[] = [];
      try {
        const debug = await debugMetaToken(client, app, { inputToken: long.access_token, signal });
        scopes = debug.scopes ?? [];
      } catch (error) {
        // The scopes are informative; a sign-in that worked is not refused over them.
        if (!(error instanceof MetaGraphError) || error.error.code === "auth") {
          throw error;
        }
      }
      const pages = await listMetaPages(client, { accessToken: long.access_token, signal });

      const candidates: OAuthCandidateRow[] = [];
      const secret: ConnectionSecret = { accounts: {} };
      const seen = new Set<string>();
      for (const page of pages) {
        const pageToken = page.access_token;
        const pageCandidateId = candidateAccountId("facebook", page.id);
        if (pageToken === undefined || seen.has(pageCandidateId)) {
          continue;
        }
        const ig = page.instagram_business_account;
        const igCandidateId = ig === undefined ? null : candidateAccountId("instagram", ig.id);
        const withIg = igCandidateId !== null && !seen.has(igCandidateId);
        if (candidates.length + (withIg ? 2 : 1) > MAX_CONNECTION_ACCOUNTS) {
          break;
        }
        seen.add(pageCandidateId);
        const pagePicture = pictureUrlOf(page.picture?.data?.url);
        candidates.push({
          id: pageCandidateId,
          platform: "facebook",
          externalId: page.id,
          name: candidateName(page.name, `Facebook Page ${page.id}`),
          parentId: null,
          ...(pagePicture === undefined ? {} : { picture: pagePicture }),
        });
        secret.accounts[pageCandidateId] = {
          accessToken: pageToken,
          tokenExpiresAt: null,
          scopes,
          extra: {},
        };
        if (withIg && ig !== undefined && igCandidateId !== null) {
          seen.add(igCandidateId);
          const username = candidateUsername(ig.username);
          const igPicture = pictureUrlOf(ig.profile_picture_url);
          candidates.push({
            id: igCandidateId,
            platform: "instagram",
            externalId: ig.id,
            name: candidateName(ig.username, page.name || `Instagram ${ig.id}`),
            ...(username === undefined ? {} : { username }),
            parentId: pageCandidateId,
            ...(igPicture === undefined ? {} : { picture: igPicture }),
          });
          secret.accounts[igCandidateId] = {
            accessToken: pageToken,
            tokenExpiresAt: null,
            scopes,
            extra: { pageId: page.id },
          };
        }
      }
      return { candidates, secret };
    },
  };
};
