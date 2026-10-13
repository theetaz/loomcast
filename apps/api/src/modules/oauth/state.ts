import { createHash, randomUUID } from "node:crypto";
import { OAUTH_STATE_TTL_MS, type OAuthProvider } from "@loomcast/contracts";
import { consumeOAuthState, type Database, oauthStates } from "@loomcast/db";
import { randomToken, sha256Hex } from "../../lib/crypto";
import { oauthStateAad, sealedSecretOf, type TokenVault } from "../../lib/vault";

// Sign-in states: 32 random bytes sent to the platform as `state`, stored only as their SHA-256,
// bound to the user who started the sign-in, valid for 10 minutes and consumed once. A provider
// that uses PKCE gets a verifier sealed next to the state.

/** Random bytes of a state value. */
export const OAUTH_STATE_BYTES = 32;

/** Random bytes of a PKCE verifier (64 base64url characters). */
const PKCE_VERIFIER_BYTES = 48;

export interface CreatedState {
  /** The value for the platform's `state` parameter. Never stored. */
  state: string;
  /** The S256 PKCE challenge, when the provider uses PKCE. */
  codeChallenge: string | null;
}

/** Creates a sign-in state for `userId`. */
export async function createOAuthState(
  db: Database,
  vault: TokenVault,
  input: {
    provider: OAuthProvider;
    userId: string;
    redirectTo: string | null;
    usesPkce: boolean;
    now: Date;
  },
): Promise<CreatedState> {
  const id = randomUUID();
  const state = randomToken(OAUTH_STATE_BYTES);
  let codeChallenge: string | null = null;
  let pkce: { pkceCiphertext: Buffer; pkceNonce: Buffer; keyVersion: number } | null = null;
  if (input.usesPkce) {
    const verifier = randomToken(PKCE_VERIFIER_BYTES);
    codeChallenge = createHash("sha256").update(verifier, "ascii").digest("base64url");
    const sealed = vault.encrypt({ codeVerifier: verifier }, oauthStateAad(id));
    pkce = {
      pkceCiphertext: sealed.secretCiphertext,
      pkceNonce: sealed.secretNonce,
      keyVersion: sealed.keyVersion,
    };
  }
  await db.insert(oauthStates).values({
    id,
    stateHash: sha256Hex(state),
    provider: input.provider,
    userId: input.userId,
    redirectTo: input.redirectTo,
    expiresAt: new Date(input.now.getTime() + OAUTH_STATE_TTL_MS),
    createdAt: input.now,
    ...(pkce ?? {}),
  });
  return { state, codeChallenge };
}

export interface ConsumedState {
  id: string;
  redirectTo: string | null;
  codeVerifier: string | null;
}

/**
 * Consumes the state the callback received, once. Null when it is unknown, expired, used, or
 * belongs to another user or provider.
 */
export async function consumeState(
  db: Database,
  vault: TokenVault,
  input: { state: string; provider: OAuthProvider; userId: string; now: Date },
): Promise<ConsumedState | null> {
  const row = await consumeOAuthState(db, {
    stateHash: sha256Hex(input.state),
    provider: input.provider,
    userId: input.userId,
    now: input.now,
  });
  if (row === null) {
    return null;
  }
  const sealed = sealedSecretOf({
    secretCiphertext: row.pkceCiphertext,
    secretNonce: row.pkceNonce,
    keyVersion: row.keyVersion,
  });
  let codeVerifier: string | null = null;
  if (sealed !== null) {
    const value = vault.decrypt(sealed, oauthStateAad(row.id));
    codeVerifier = typeof value.codeVerifier === "string" ? value.codeVerifier : null;
  }
  return { id: row.id, redirectTo: row.redirectTo, codeVerifier };
}
