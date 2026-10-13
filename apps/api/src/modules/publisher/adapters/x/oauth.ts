import { z } from "zod";
import type { XAppConfig } from "../../../../env";
import { publishError } from "../../errors";
import { XApiError, type XClient } from "./client";

// The X OAuth 2.0 calls: the authorization URL (PKCE with S256), the code exchange and the token
// refresh at `POST /2/oauth2/token` (a confidential client authenticates with HTTP Basic), and the
// signed-in user (`GET /2/users/me`). Access tokens live two hours; with `offline.access` a
// refresh token comes along, and every refresh returns a new pair: the old refresh token stops
// working, so the new pair must be stored before anything else uses it.

/** The consent page. */
export const X_AUTHORIZE_URL = "https://x.com/i/oauth2/authorize";

/** The token endpoint, on the API host. */
export const X_TOKEN_PATH = "/2/oauth2/token";

/** What Loomcast asks for: read and post, read the profile, upload media, refresh offline. */
export const X_SCOPES = [
  "tweet.read",
  "tweet.write",
  "users.read",
  "media.write",
  "offline.access",
] as const;

/** The consent URL for `state` and the S256 `codeChallenge`. */
export function xAuthorizeUrl(
  app: XAppConfig,
  input: { redirectUri: string; state: string; codeChallenge: string },
): string {
  const url = new URL(X_AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", app.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("scope", X_SCOPES.join(" "));
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

const XTokenResponseSchema = z.object({
  token_type: z.string().optional(),
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().int().positive(),
  scope: z.string().optional(),
});

/** A token pair as Loomcast keeps it. */
export interface XTokenPair {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  scopes: string[];
}

function malformed(what: string): XApiError {
  return new XApiError(
    publishError("transient", `The X API answered ${what} in an unexpected form.`),
    { status: 200 },
  );
}

function pairOf(data: unknown, now: Date): XTokenPair {
  const parsed = XTokenResponseSchema.safeParse(data);
  if (!parsed.success) {
    throw malformed("the token request");
  }
  if (parsed.data.refresh_token === undefined) {
    // Without `offline.access` granted the channel would stop working after two hours.
    throw new XApiError(
      publishError(
        "permission",
        "X did not grant offline access; sign in again and allow every permission.",
        { retryable: false },
      ),
      { status: 200 },
    );
  }
  return {
    accessToken: parsed.data.access_token,
    refreshToken: parsed.data.refresh_token,
    expiresAt: new Date(now.getTime() + parsed.data.expires_in * 1000),
    scopes: (parsed.data.scope ?? X_SCOPES.join(" ")).split(/\s+/).filter((s) => s !== ""),
  };
}

/** Exchanges an authorization code (with its PKCE verifier) for a token pair. */
export async function exchangeXCode(
  client: XClient,
  app: XAppConfig,
  input: {
    code: string;
    redirectUri: string;
    codeVerifier: string;
    now: Date;
    signal?: AbortSignal | undefined;
  },
): Promise<XTokenPair> {
  const response = await client.request({
    method: "POST",
    path: X_TOKEN_PATH,
    client: app,
    form: {
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: input.redirectUri,
      code_verifier: input.codeVerifier,
      client_id: app.clientId,
    },
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  return pairOf(response.data, input.now);
}

/** Trades `refreshToken` for a new pair. The old refresh token is spent once this succeeds. */
export async function refreshXToken(
  client: XClient,
  app: XAppConfig,
  input: { refreshToken: string; now: Date; signal?: AbortSignal | undefined },
): Promise<XTokenPair> {
  const response = await client.request({
    method: "POST",
    path: X_TOKEN_PATH,
    client: app,
    form: {
      grant_type: "refresh_token",
      refresh_token: input.refreshToken,
      client_id: app.clientId,
    },
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  return pairOf(response.data, input.now);
}

const XMeSchema = z.object({
  data: z.object({
    id: z.string().regex(/^\d{1,20}$/),
    name: z.string().optional(),
    username: z.string().optional(),
    profile_image_url: z.string().optional(),
  }),
});

export type XUser = z.infer<typeof XMeSchema>["data"];

/** The signed-in user: id, name, handle and profile picture. */
export async function getXUser(
  client: XClient,
  input: { accessToken: string; signal?: AbortSignal | undefined },
): Promise<XUser> {
  const response = await client.request({
    path: "/2/users/me",
    query: { "user.fields": "username,name,profile_image_url" },
    accessToken: input.accessToken,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  const parsed = XMeSchema.safeParse(response.data);
  if (!parsed.success) {
    throw malformed("the profile request");
  }
  return parsed.data.data;
}
