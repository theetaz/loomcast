import { z } from "zod";
import type { PlatformsConfig, ThreadsAppConfig } from "../../env";
import { createGraphClient, type GraphClient, type GraphClientOptions } from "./client";
import { parseGraph } from "./parse";

// The Threads API calls of the Threads sign-in, as confirmed against Meta's documentation:
// - authorization window: `https://threads.com/oauth/authorize` with `client_id`, `redirect_uri`,
//   `scope` (comma-separated), `response_type=code` and `state`;
// - code exchange: `POST https://graph.threads.net/oauth/access_token` (form: `client_id`,
//   `client_secret`, `code`, `grant_type=authorization_code`, `redirect_uri`), a short-lived token;
// - long-lived token (60 days): `GET /access_token?grant_type=th_exchange_token`;
// - refresh (60 more days, for a token at least a day old): `GET /refresh_access_token?
//   grant_type=th_refresh_token`;
// - profile: `GET /v1.0/me?fields=id,username`;
// - app check: `GET /oauth/access_token?grant_type=client_credentials`.
// The Threads API takes the token as the `access_token` parameter and does not document
// `appsecret_proof`, so the client sends none.

/** Version of the Threads API. */
export const THREADS_API_VERSION = "v1.0";

/** The Threads authorization window (`threads.net` redirects here). */
export const THREADS_AUTHORIZE_URL = "https://threads.com/oauth/authorize";

/** The permissions a Threads sign-in asks for. */
export const THREADS_SCOPES = [
  "threads_basic",
  "threads_content_publish",
  "threads_manage_insights",
] as const;

/** The Threads API client of `platforms`. */
export function createThreadsGraphClient(
  platforms: Pick<PlatformsConfig, "threadsGraphBaseUrl">,
  options: Partial<GraphClientOptions> = {},
): GraphClient {
  return createGraphClient({
    baseUrl: platforms.threadsGraphBaseUrl,
    version: THREADS_API_VERSION,
    appSecret: null,
    tokenPlacement: "parameter",
    ...options,
  });
}

/** The authorization window URL a Threads sign-in starts at. */
export function threadsAuthorizeUrl(
  app: ThreadsAppConfig,
  input: { redirectUri: string; state: string },
): string {
  const url = new URL(THREADS_AUTHORIZE_URL);
  url.searchParams.set("client_id", app.appId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("scope", THREADS_SCOPES.join(","));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", input.state);
  return url.toString();
}

const ShortLivedTokenSchema = z.object({
  access_token: z.string().min(1),
  user_id: z.union([z.string(), z.number()]).transform(String).optional(),
});

const LongLivedTokenSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().optional(),
  expires_in: z.number().int().positive(),
});
export type ThreadsLongLivedToken = z.infer<typeof LongLivedTokenSchema>;

/** Exchanges the authorization `code` for a short-lived token. Never retried: a code works once. */
export async function exchangeThreadsCode(
  client: GraphClient,
  app: ThreadsAppConfig,
  input: { code: string; redirectUri: string; signal?: AbortSignal },
): Promise<z.infer<typeof ShortLivedTokenSchema>> {
  const response = await client.request({
    method: "POST",
    path: "/oauth/access_token",
    versioned: false,
    form: {
      client_id: app.appId,
      client_secret: app.appSecret,
      code: input.code,
      grant_type: "authorization_code",
      redirect_uri: input.redirectUri,
    },
    retry: false,
    signal: input.signal,
  });
  return parseGraph(ShortLivedTokenSchema, response, "the code exchange");
}

/** Exchanges a short-lived token for a long-lived one (60 days). */
export async function exchangeThreadsLongLivedToken(
  client: GraphClient,
  app: ThreadsAppConfig,
  input: { accessToken: string; signal?: AbortSignal },
): Promise<ThreadsLongLivedToken> {
  const response = await client.request({
    path: "/access_token",
    versioned: false,
    query: { grant_type: "th_exchange_token", client_secret: app.appSecret },
    accessToken: input.accessToken,
    retry: false,
    signal: input.signal,
  });
  return parseGraph(LongLivedTokenSchema, response, "the long-lived token exchange");
}

/** Refreshes a long-lived token for another 60 days. */
export async function refreshThreadsToken(
  client: GraphClient,
  input: { accessToken: string; signal?: AbortSignal },
): Promise<ThreadsLongLivedToken> {
  const response = await client.request({
    path: "/refresh_access_token",
    versioned: false,
    query: { grant_type: "th_refresh_token" },
    accessToken: input.accessToken,
    signal: input.signal,
  });
  return parseGraph(LongLivedTokenSchema, response, "the token refresh");
}

const ProfileSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  username: z.string().optional(),
});
export type ThreadsProfile = z.infer<typeof ProfileSchema>;

/** The profile the token belongs to. Also how a Threads token is checked. */
export async function getThreadsProfile(
  client: GraphClient,
  input: { accessToken: string; signal?: AbortSignal },
): Promise<ThreadsProfile> {
  const response = await client.request({
    path: "/me",
    query: { fields: "id,username" },
    accessToken: input.accessToken,
    signal: input.signal,
  });
  return parseGraph(ProfileSchema, response, "the profile");
}

const AppTokenSchema = z.object({ access_token: z.string().min(1) });

/** An app access token from the Threads app id and secret (`grant_type=client_credentials`). */
export async function threadsAppAccessToken(
  client: GraphClient,
  app: ThreadsAppConfig,
  signal?: AbortSignal,
): Promise<string> {
  const response = await client.request({
    path: "/oauth/access_token",
    versioned: false,
    query: {
      client_id: app.appId,
      client_secret: app.appSecret,
      grant_type: "client_credentials",
    },
    signal,
  });
  return parseGraph(AppTokenSchema, response, "the app token request").access_token;
}
