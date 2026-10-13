import type { OAuthProvider } from "@loomcast/contracts";
import type { OAuthCandidateRow } from "@loomcast/db";
import { z } from "zod";
import type { PlatformsConfig } from "../../env";
import type { FetchLike } from "../../lib/meta-graph";

// A sign-in provider turns the platform's authorization `code` into the accounts the sign-in can
// publish as (`candidates`, no credentials) and the credentials of each of them (`secret`, sealed
// into the pending connection). Each provider lives in its own file and is listed in
// `providers.ts`.

/** The credentials a candidate's channel gets when it is accepted. */
export const CandidateSecretSchema = z.object({
  accessToken: z.string().min(1),
  /** ISO time the token expires; null when it does not (Page tokens). */
  tokenExpiresAt: z.string().nullable(),
  /** Permissions the token was granted. */
  scopes: z.array(z.string()),
  /** Platform values the publisher needs besides the token, such as the Page id of an account. */
  extra: z.record(z.string(), z.string()).default({}),
});
export type CandidateSecret = z.infer<typeof CandidateSecretSchema>;

/** The sealed secret of a pending connection: the credentials of every candidate, by id. */
export const ConnectionSecretSchema = z.object({
  accounts: z.record(z.string(), CandidateSecretSchema),
});
export type ConnectionSecret = z.infer<typeof ConnectionSecretSchema>;

/** What a finished sign-in produced. */
export interface SignInResult {
  candidates: OAuthCandidateRow[];
  secret: ConnectionSecret;
}

export interface CompleteSignInInput {
  code: string;
  redirectUri: string;
  /** The PKCE verifier `start` created, for providers that use PKCE. */
  codeVerifier: string | null;
  now: Date;
  signal?: AbortSignal;
}

export interface OAuthProviderAdapter {
  readonly provider: OAuthProvider;
  /** False when the server cannot use the provider: no app credentials, or a feature flag off. */
  available(): boolean;
  /** Whether `start` creates a PKCE verifier (sealed in `oauth_states`). */
  readonly usesPkce: boolean;
  /** The platform's consent URL. `codeChallenge` is the S256 challenge when `usesPkce`. */
  authorizeUrl(input: { state: string; redirectUri: string; codeChallenge: string | null }): string;
  /** Exchanges the code and lists the accounts. Throws `MetaGraphError` (or similar) on failure. */
  complete(input: CompleteSignInInput): Promise<SignInResult>;
}

export interface OAuthProviderDeps {
  platforms: PlatformsConfig;
  /** Overrides the global `fetch` of the platform clients. */
  fetch?: FetchLike;
}

export type OAuthProviderFactory = (deps: OAuthProviderDeps) => OAuthProviderAdapter;
