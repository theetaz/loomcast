import {
  type CandidateAccount,
  MAX_CONNECTION_ACCOUNTS,
  OAUTH_REDIRECT_TO_MAX_LENGTH,
} from "@loomcast/contracts";
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { CHANNEL_SECRET_NONCE_BYTES, CHANNEL_SECRET_TAG_BYTES } from "./channels";
import { bytea, createdAt, timestamptz, uuidPrimaryKey } from "./columns";
import { oauthProvider } from "./enums";
import { users } from "./users";

const NONCE_BYTES = sql.raw(String(CHANNEL_SECRET_NONCE_BYTES));
const TAG_BYTES = sql.raw(String(CHANNEL_SECRET_TAG_BYTES));

/**
 * A sign-in started by `oauth.start` and not yet back through `oauth.callback`. The state sent to
 * the platform is never stored: `stateHash` is the lowercase hex SHA-256 of it
 * (`oauth_states_state_hash_ck` refuses anything else), so a leaked row cannot complete a sign-in.
 *
 * - **Single use.** The callback consumes the state with `consumeOAuthState`, which matches the
 *   hash, provider and user, refuses an expired or used state, sets `usedAt` and returns the row in
 *   one statement. A replayed state finds nothing.
 * - **PKCE.** The code verifier, when the provider uses one, is stored only as token-vault output:
 *   `pkceCiphertext` (with the 16-byte GCM tag appended), its 12-byte `pkceNonce` and `keyVersion`,
 *   set or cleared together (`oauth_states_pkce_ck`). Consuming the state clears them, and a used
 *   state never keeps a verifier (`oauth_states_pkce_used_ck`).
 * - **Expiry.** `expiresAt` is `OAUTH_STATE_TTL_MS` after creation. `purgeExpiredOAuth` deletes
 *   expired rows through `oauth_states_expires_at_idx`.
 */
export const oauthStates = pgTable(
  "oauth_states",
  {
    id: uuidPrimaryKey(),
    /** SHA-256 of the state value, lowercase hex. The state itself is never stored. */
    stateHash: text("state_hash").notNull(),
    provider: oauthProvider("provider").notNull(),
    /** The user who started the sign-in; the callback must come from the same user. */
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    pkceCiphertext: bytea("pkce_ciphertext"),
    pkceNonce: bytea("pkce_nonce"),
    keyVersion: integer("key_version"),
    /** The app path to return to after the connect page (`OAuthRedirectToSchema`). */
    redirectTo: text("redirect_to"),
    expiresAt: timestamptz("expires_at").notNull(),
    usedAt: timestamptz("used_at"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("oauth_states_state_hash_uq").on(t.stateHash),
    index("oauth_states_user_id_idx").on(t.userId),
    index("oauth_states_expires_at_idx").on(t.expiresAt),
    check("oauth_states_state_hash_ck", sql`${t.stateHash} ~ '^[0-9a-f]{64}$'`),
    check(
      "oauth_states_pkce_ck",
      sql`num_nulls(${t.pkceCiphertext}, ${t.pkceNonce}, ${t.keyVersion}) in (0, 3)`,
    ),
    check("oauth_states_pkce_nonce_ck", sql`octet_length(${t.pkceNonce}) = ${NONCE_BYTES}`),
    check("oauth_states_pkce_ciphertext_ck", sql`octet_length(${t.pkceCiphertext}) > ${TAG_BYTES}`),
    check("oauth_states_key_version_ck", sql`${t.keyVersion} >= 1`),
    check("oauth_states_pkce_used_ck", sql`${t.usedAt} is null or ${t.pkceCiphertext} is null`),
    check(
      "oauth_states_redirect_to_ck",
      sql`char_length(${t.redirectTo}) <= ${sql.raw(String(OAUTH_REDIRECT_TO_MAX_LENGTH))} and ${t.redirectTo} like '/%'`,
    ),
    check("oauth_states_expires_at_ck", sql`${t.expiresAt} > ${t.createdAt}`),
  ],
);

/**
 * An account a pending connection offers, as stored: the contracts' `CandidateAccount` without
 * `alreadyConnected`, which is worked out from `channels` when the connection is read, and with
 * the platform's address of its profile picture (`picture`) in place of the API path the web app
 * gets. It holds no credential; the tokens of every candidate are in the connection's sealed
 * secret.
 */
export type OAuthCandidateRow = Omit<CandidateAccount, "alreadyConnected" | "pictureUrl"> & {
  picture?: string;
};

/**
 * A finished sign-in waiting for the user to choose the accounts to connect. The callback stores
 * the accounts the sign-in can publish as in `candidates` (no credentials) and every token in the
 * sealed secret; `oauth.accept` turns the chosen candidates into channels.
 *
 * - **Credentials** use the same columns and format as `channels`: `secretCiphertext` (the
 *   encrypted JSON with the 16-byte GCM tag appended), the 12-byte `secretNonce` and `keyVersion`,
 *   set or cleared together (`oauth_connections_secret_ck`). Never select them into a response or
 *   a log line. Key rotation must cover this table as well as `channels`.
 * - **Single use.** A pending connection has a secret and a consumed one has none
 *   (`oauth_connections_consumed_ck`). `consumeOAuthConnection` checks the user and expiry, sets
 *   `consumedAt`, clears the secret and returns the row with the secret it had, in one statement;
 *   call it in the transaction that creates the channels.
 * - **Expiry.** `expiresAt` is `OAUTH_CONNECTION_TTL_MS` after the callback. `purgeExpiredOAuth`
 *   deletes expired rows through `oauth_connections_expires_at_idx`.
 */
export const oauthConnections = pgTable(
  "oauth_connections",
  {
    id: uuidPrimaryKey(),
    provider: oauthProvider("provider").notNull(),
    /** The user who signed in; only they may read or accept the connection. */
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    secretCiphertext: bytea("secret_ciphertext"),
    secretNonce: bytea("secret_nonce"),
    keyVersion: integer("key_version"),
    candidates: jsonb("candidates").$type<OAuthCandidateRow[]>().notNull().default([]),
    expiresAt: timestamptz("expires_at").notNull(),
    consumedAt: timestamptz("consumed_at"),
    createdAt: createdAt(),
  },
  (t) => [
    index("oauth_connections_user_id_idx").on(t.userId),
    index("oauth_connections_expires_at_idx").on(t.expiresAt),
    check(
      "oauth_connections_secret_ck",
      sql`num_nulls(${t.secretCiphertext}, ${t.secretNonce}, ${t.keyVersion}) in (0, 3)`,
    ),
    check(
      "oauth_connections_secret_nonce_ck",
      sql`octet_length(${t.secretNonce}) = ${NONCE_BYTES}`,
    ),
    check(
      "oauth_connections_secret_ciphertext_ck",
      sql`octet_length(${t.secretCiphertext}) > ${TAG_BYTES}`,
    ),
    check("oauth_connections_key_version_ck", sql`${t.keyVersion} >= 1`),
    check(
      "oauth_connections_consumed_ck",
      sql`(${t.consumedAt} is null) = (${t.secretCiphertext} is not null)`,
    ),
    check(
      "oauth_connections_candidates_ck",
      sql`case when jsonb_typeof(${t.candidates}) = 'array' then jsonb_array_length(${t.candidates}) <= ${sql.raw(String(MAX_CONNECTION_ACCOUNTS))} else false end`,
    ),
    check("oauth_connections_expires_at_ck", sql`${t.expiresAt} > ${t.createdAt}`),
  ],
);

export type OAuthStateRow = typeof oauthStates.$inferSelect;
export type NewOAuthStateRow = typeof oauthStates.$inferInsert;
export type OAuthConnectionRow = typeof oauthConnections.$inferSelect;
export type NewOAuthConnectionRow = typeof oauthConnections.$inferInsert;
