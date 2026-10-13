import type { OAuthProvider } from "@loomcast/contracts";
import { getTableColumns, lte, type SQL, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import type { Database } from "../client";
import {
  type OAuthConnectionRow,
  type OAuthStateRow,
  oauthConnections,
  oauthStates,
} from "../schema";

// Single use of sign-in states and pending connections. Each consume is one statement that checks
// the row, marks it used, clears its sealed secret and returns the row with the secret it had, so a
// replay finds nothing and no used row keeps a credential. Every function takes the database or a
// transaction and an optional `now` for tests with a fake clock; by default the database clock
// decides.

/** Anything with the query builders and raw queries: a transaction, or the database. */
export type OAuthExecutor = Pick<Database, "execute" | "delete">;

function at(now: Date | undefined): SQL {
  return now === undefined ? sql`now()` : sql`${now.toISOString()}::timestamptz`;
}

/**
 * The `returning` list and decoder for a raw statement on `table`. Columns named in `previous` are
 * read from the `old` subquery (their values before the update), the rest from the updated row.
 * Raw queries skip Drizzle's decoding (the driver returns timestamps as text), so each value goes
 * through its column's mapper.
 */
function rowReader<Row>(table: PgTable, previous: readonly string[]) {
  const columns = Object.entries(getTableColumns(table));
  const list = sql.join(
    columns.map(([key, column]) => {
      const source = previous.includes(key) ? sql`old` : sql`updated`;
      return sql`${source}.${sql.identifier(column.name)} as ${sql.identifier(key)}`;
    }),
    sql`, `,
  );
  const decode = (raw: Record<string, unknown>): Row => {
    const row: Record<string, unknown> = {};
    for (const [key, column] of columns) {
      const value = raw[key];
      row[key] = value === null || value === undefined ? null : column.mapFromDriverValue(value);
    }
    return row as Row;
  };
  return { list, decode };
}

const stateReader = rowReader<OAuthStateRow>(oauthStates, [
  "pkceCiphertext",
  "pkceNonce",
  "keyVersion",
]);

export interface ConsumeOAuthStateInput {
  /** SHA-256 of the state the callback received, lowercase hex. */
  stateHash: string;
  provider: OAuthProvider;
  /** The signed-in user of the callback; a state started by someone else is not consumed. */
  userId: string;
  now?: Date;
}

/**
 * Consumes the sign-in state with `stateHash`, once. It must belong to `provider` and `userId`, be
 * unused and not have expired. Returns the row as it was, with its PKCE verifier still sealed, and
 * leaves it used with the verifier cleared; returns null when no state matches (unknown, expired,
 * used, or another user's or provider's), which the callback answers with `invalid_state`.
 * Concurrent callbacks with the same state consume it at most once.
 */
export async function consumeOAuthState(
  db: OAuthExecutor,
  input: ConsumeOAuthStateInput,
): Promise<OAuthStateRow | null> {
  const now = at(input.now);
  const result = await db.execute<Record<string, unknown>>(sql`
    update oauth_states as updated
    set used_at = ${now}, pkce_ciphertext = null, pkce_nonce = null, key_version = null
    from (
      select id, pkce_ciphertext, pkce_nonce, key_version
      from oauth_states
      where state_hash = ${input.stateHash}
        and provider = ${input.provider}
        and user_id = ${input.userId}
        and used_at is null
        and expires_at > ${now}
      for update
    ) as old
    where updated.id = old.id
    returning ${stateReader.list}
  `);
  const [raw] = result.rows;
  return raw === undefined ? null : stateReader.decode(raw);
}

const connectionReader = rowReader<OAuthConnectionRow>(oauthConnections, [
  "secretCiphertext",
  "secretNonce",
  "keyVersion",
]);

export interface ConsumeOAuthConnectionInput {
  id: string;
  /** The signed-in user; only the user who signed in may accept the connection. */
  userId: string;
  now?: Date;
}

/**
 * Consumes the pending connection `id`, once: it must belong to `userId`, be unconsumed and not
 * have expired. Returns the row as it was, with its sealed secret, and leaves it consumed with the
 * secret cleared; returns null otherwise (`410 connection_expired`, or `404` for another user's).
 * Call it in the transaction that creates the channels, so a failure keeps the connection pending.
 */
export async function consumeOAuthConnection(
  db: OAuthExecutor,
  input: ConsumeOAuthConnectionInput,
): Promise<OAuthConnectionRow | null> {
  const now = at(input.now);
  const result = await db.execute<Record<string, unknown>>(sql`
    update oauth_connections as updated
    set consumed_at = ${now}, secret_ciphertext = null, secret_nonce = null, key_version = null
    from (
      select id, secret_ciphertext, secret_nonce, key_version
      from oauth_connections
      where id = ${input.id}
        and user_id = ${input.userId}
        and consumed_at is null
        and expires_at > ${now}
      for update
    ) as old
    where updated.id = old.id
    returning ${connectionReader.list}
  `);
  const [raw] = result.rows;
  return raw === undefined ? null : connectionReader.decode(raw);
}

export interface PurgeExpiredOAuthResult {
  states: number;
  connections: number;
}

/**
 * Deletes sign-in states and pending connections that expired at or before `now`, used or not.
 * Both deletes go through the `expires_at` indexes. Run it from a recurring task.
 */
export async function purgeExpiredOAuth(
  db: OAuthExecutor,
  options: { now?: Date } = {},
): Promise<PurgeExpiredOAuthResult> {
  const now = at(options.now);
  const states = await db
    .delete(oauthStates)
    .where(lte(oauthStates.expiresAt, now))
    .returning({ id: oauthStates.id });
  const connections = await db
    .delete(oauthConnections)
    .where(lte(oauthConnections.expiresAt, now))
    .returning({ id: oauthConnections.id });
  return { states: states.length, connections: connections.length };
}
