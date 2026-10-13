import { randomBytes } from "node:crypto";
import { OAUTH_CONNECTION_TTL_MS, OAUTH_STATE_TTL_MS } from "@loomcast/contracts";
import { eq, type SQL, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { consumeOAuthConnection, consumeOAuthState, purgeExpiredOAuth } from "../src/queries/oauth";
import { oauthConnections, oauthStates, users } from "../src/schema";
import { createTestDb, type TestDb } from "../src/testing";
import {
  insertOAuthConnection,
  insertOAuthState,
  insertUser,
  oauthState,
  PG,
  pgError,
  sealedPkce,
  sealedSecret,
} from "./fixtures";

let testDb: TestDb;

beforeAll(async () => {
  testDb = await createTestDb();
});

afterAll(async () => {
  await testDb.drop();
});

/** The plan Postgres picks for `query` when it may not scan whole tables. */
async function planWithoutSeqScan(query: SQL): Promise<string> {
  return testDb.db.transaction(async (tx) => {
    await tx.execute(sql`set local enable_seqscan = off`);
    const result = await tx.execute<{ "QUERY PLAN": string }>(sql`explain ${query}`);
    return result.rows.map((row) => row["QUERY PLAN"]).join("\n");
  });
}

describe("oauth_states", () => {
  it("store only the hash of the state, never the state itself", async () => {
    const user = await insertUser(testDb.db);
    const { value, hash } = oauthState();

    const stored = await insertOAuthState(testDb.db, { userId: user.id, stateHash: hash });
    expect(stored.stateHash).toBe(hash);
    expect(
      await pgError(insertOAuthState(testDb.db, { userId: user.id, stateHash: value })),
    ).toEqual({ code: PG.checkViolation, constraint: "oauth_states_state_hash_ck" });
    expect(
      await pgError(insertOAuthState(testDb.db, { userId: user.id, stateHash: hash })),
    ).toEqual({ code: PG.uniqueViolation, constraint: "oauth_states_state_hash_uq" });
  });

  it("are consumed once, returning the sealed verifier and clearing it", async () => {
    const user = await insertUser(testDb.db);
    const { hash } = oauthState();
    const pkce = sealedPkce(2);
    const state = await insertOAuthState(testDb.db, {
      userId: user.id,
      stateHash: hash,
      provider: "threads",
      redirectTo: "/settings/channels",
      ...pkce,
    });

    const consumed = await consumeOAuthState(testDb.db, {
      stateHash: hash,
      provider: "threads",
      userId: user.id,
    });
    expect(consumed).toMatchObject({
      id: state.id,
      provider: "threads",
      userId: user.id,
      redirectTo: "/settings/channels",
      keyVersion: 2,
      expiresAt: state.expiresAt,
      createdAt: state.createdAt,
    });
    expect(consumed?.usedAt).toBeInstanceOf(Date);
    expect(consumed?.pkceCiphertext?.equals(pkce.pkceCiphertext)).toBe(true);
    expect(consumed?.pkceNonce?.equals(pkce.pkceNonce)).toBe(true);

    const [stored] = await testDb.db.select().from(oauthStates).where(eq(oauthStates.id, state.id));
    expect(stored).toMatchObject({
      usedAt: consumed?.usedAt,
      pkceCiphertext: null,
      pkceNonce: null,
      keyVersion: null,
    });

    expect(
      await consumeOAuthState(testDb.db, { stateHash: hash, provider: "threads", userId: user.id }),
    ).toBeNull();
  });

  it("are consumed at most once by concurrent callbacks", async () => {
    const user = await insertUser(testDb.db);
    const { hash } = oauthState();
    await insertOAuthState(testDb.db, { userId: user.id, stateHash: hash, ...sealedPkce() });

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        consumeOAuthState(testDb.db, { stateHash: hash, provider: "meta", userId: user.id }),
      ),
    );
    expect(results.filter((result) => result !== null)).toHaveLength(1);
  });

  it("are not consumed by another user or provider, nor once expired", async () => {
    const owner = await insertUser(testDb.db);
    const other = await insertUser(testDb.db);
    const { hash } = oauthState();
    const state = await insertOAuthState(testDb.db, { userId: owner.id, stateHash: hash });
    const input = { stateHash: hash, provider: "meta" as const, userId: owner.id };

    expect(await consumeOAuthState(testDb.db, { ...input, userId: other.id })).toBeNull();
    expect(await consumeOAuthState(testDb.db, { ...input, provider: "threads" })).toBeNull();
    expect(await consumeOAuthState(testDb.db, { ...input, now: state.expiresAt })).toBeNull();
    expect(
      await consumeOAuthState(testDb.db, { ...input, stateHash: oauthState().hash }),
    ).toBeNull();

    // None of the refusals used the state up.
    const consumed = await consumeOAuthState(testDb.db, {
      ...input,
      now: new Date(state.expiresAt.getTime() - 1),
    });
    expect(consumed?.id).toBe(state.id);
  });

  it("keep the verifier only as complete vault output, and never once used", async () => {
    const user = await insertUser(testDb.db);
    const pkce = sealedPkce();
    const cases = [
      [{ pkceCiphertext: pkce.pkceCiphertext }, "oauth_states_pkce_ck"],
      [{ ...pkce, pkceNonce: randomBytes(8) }, "oauth_states_pkce_nonce_ck"],
      [{ ...pkce, pkceCiphertext: randomBytes(16) }, "oauth_states_pkce_ciphertext_ck"],
      [{ ...pkce, keyVersion: 0 }, "oauth_states_key_version_ck"],
      [{ ...pkce, usedAt: new Date() }, "oauth_states_pkce_used_ck"],
    ] as const;
    for (const [values, constraint] of cases) {
      expect(await pgError(insertOAuthState(testDb.db, { userId: user.id, ...values }))).toEqual({
        code: PG.checkViolation,
        constraint,
      });
    }
    // A used state without a verifier, and a state of a provider without PKCE, are fine.
    await insertOAuthState(testDb.db, { userId: user.id, usedAt: new Date() });
  });

  it("accept only app paths as the redirect, and an expiry after creation", async () => {
    const user = await insertUser(testDb.db);
    for (const redirectTo of ["https://example.com/", `/${"a".repeat(512)}`]) {
      expect(await pgError(insertOAuthState(testDb.db, { userId: user.id, redirectTo }))).toEqual({
        code: PG.checkViolation,
        constraint: "oauth_states_redirect_to_ck",
      });
    }
    const createdAt = new Date();
    expect(
      await pgError(
        insertOAuthState(testDb.db, { userId: user.id, createdAt, expiresAt: createdAt }),
      ),
    ).toEqual({ code: PG.checkViolation, constraint: "oauth_states_expires_at_ck" });
  });

  it("go when their user is deleted", async () => {
    const user = await insertUser(testDb.db);
    const state = await insertOAuthState(testDb.db, { userId: user.id });
    const connection = await insertOAuthConnection(testDb.db, { userId: user.id });

    await testDb.db.delete(users).where(eq(users.id, user.id));

    expect(await testDb.db.select().from(oauthStates).where(eq(oauthStates.id, state.id))).toEqual(
      [],
    );
    expect(
      await testDb.db.select().from(oauthConnections).where(eq(oauthConnections.id, connection.id)),
    ).toEqual([]);
  });
});

describe("oauth_connections", () => {
  it("are consumed once, returning the sealed secret and clearing it", async () => {
    const user = await insertUser(testDb.db);
    const secret = sealedSecret(4);
    const connection = await insertOAuthConnection(testDb.db, { userId: user.id, ...secret });

    const consumed = await consumeOAuthConnection(testDb.db, {
      id: connection.id,
      userId: user.id,
    });
    expect(consumed).toMatchObject({
      id: connection.id,
      provider: "meta",
      keyVersion: 4,
      candidates: connection.candidates,
      expiresAt: connection.expiresAt,
    });
    expect(consumed?.consumedAt).toBeInstanceOf(Date);
    expect(consumed?.secretCiphertext?.equals(secret.secretCiphertext)).toBe(true);
    expect(consumed?.secretNonce?.equals(secret.secretNonce)).toBe(true);

    const [stored] = await testDb.db
      .select()
      .from(oauthConnections)
      .where(eq(oauthConnections.id, connection.id));
    expect(stored).toMatchObject({
      consumedAt: consumed?.consumedAt,
      secretCiphertext: null,
      secretNonce: null,
      keyVersion: null,
      candidates: connection.candidates,
    });

    expect(
      await consumeOAuthConnection(testDb.db, { id: connection.id, userId: user.id }),
    ).toBeNull();
  });

  it("stay pending when the accept transaction fails", async () => {
    const user = await insertUser(testDb.db);
    const connection = await insertOAuthConnection(testDb.db, { userId: user.id });

    await expect(
      testDb.db.transaction(async (tx) => {
        expect(
          await consumeOAuthConnection(tx, { id: connection.id, userId: user.id }),
        ).not.toBeNull();
        throw new Error("channel insert failed");
      }),
    ).rejects.toThrow("channel insert failed");

    const consumed = await consumeOAuthConnection(testDb.db, {
      id: connection.id,
      userId: user.id,
    });
    expect(consumed?.secretCiphertext?.equals(connection.secretCiphertext as Buffer)).toBe(true);
  });

  it("are not consumed by another user nor once expired", async () => {
    const owner = await insertUser(testDb.db);
    const other = await insertUser(testDb.db);
    const connection = await insertOAuthConnection(testDb.db, { userId: owner.id });

    expect(
      await consumeOAuthConnection(testDb.db, { id: connection.id, userId: other.id }),
    ).toBeNull();
    expect(
      await consumeOAuthConnection(testDb.db, {
        id: connection.id,
        userId: owner.id,
        now: connection.expiresAt,
      }),
    ).toBeNull();
    expect(
      await consumeOAuthConnection(testDb.db, { id: connection.id, userId: owner.id }),
    ).not.toBeNull();
  });

  it("hold a secret exactly while pending, and a list of candidates", async () => {
    const user = await insertUser(testDb.db);
    const secret = sealedSecret();
    const nulls = { secretCiphertext: null, secretNonce: null, keyVersion: null };
    const cases = [
      [nulls, "oauth_connections_consumed_ck"],
      [{ ...secret, consumedAt: new Date() }, "oauth_connections_consumed_ck"],
      [{ ...nulls, secretCiphertext: secret.secretCiphertext }, "oauth_connections_secret_ck"],
      [{ secretNonce: randomBytes(16) }, "oauth_connections_secret_nonce_ck"],
      [{ secretCiphertext: randomBytes(16) }, "oauth_connections_secret_ciphertext_ck"],
      [{ keyVersion: 0 }, "oauth_connections_key_version_ck"],
    ] as const;
    for (const [values, constraint] of cases) {
      expect(
        await pgError(insertOAuthConnection(testDb.db, { userId: user.id, ...values })),
      ).toEqual({ code: PG.checkViolation, constraint });
    }

    const objectCandidates = sql`'{}'::jsonb`;
    const tooMany = sql`(select jsonb_agg(n) from generate_series(1, 101) as n)`;
    for (const candidates of [objectCandidates, tooMany]) {
      expect(
        await pgError(
          testDb.db.execute(sql`
            insert into oauth_connections
              (provider, user_id, secret_ciphertext, secret_nonce, key_version, candidates,
               expires_at)
            values ('meta', ${user.id}, ${secret.secretCiphertext}, ${secret.secretNonce}, 1,
                    ${candidates}, now() + interval '30 minutes')`),
        ),
      ).toEqual({ code: PG.checkViolation, constraint: "oauth_connections_candidates_ck" });
    }
    await insertOAuthConnection(testDb.db, { userId: user.id, ...nulls, consumedAt: new Date() });
  });
});

describe("expired sign-ins", () => {
  it("are purged by expiry, used or not, leaving live ones", async () => {
    const user = await insertUser(testDb.db);
    const now = new Date(Date.now() + OAUTH_CONNECTION_TTL_MS + OAUTH_STATE_TTL_MS);
    const live = { expiresAt: new Date(now.getTime() + OAUTH_STATE_TTL_MS) };
    const expiredState = await insertOAuthState(testDb.db, { userId: user.id });
    const usedState = await insertOAuthState(testDb.db, { userId: user.id, usedAt: new Date() });
    const liveState = await insertOAuthState(testDb.db, { userId: user.id, ...live });
    const expiredConnection = await insertOAuthConnection(testDb.db, { userId: user.id });
    const liveConnection = await insertOAuthConnection(testDb.db, { userId: user.id, ...live });

    const before = await testDb.db.select({ id: oauthStates.id }).from(oauthStates);
    const result = await purgeExpiredOAuth(testDb.db, { now });

    expect(result.states).toBeGreaterThanOrEqual(2);
    expect(result.connections).toBeGreaterThanOrEqual(1);
    const states = await testDb.db.select({ id: oauthStates.id }).from(oauthStates);
    const stateIds = states.map((row) => row.id);
    expect(stateIds).toContain(liveState.id);
    expect(stateIds).not.toContain(expiredState.id);
    expect(stateIds).not.toContain(usedState.id);
    expect(states.length).toBe(before.length - result.states);
    const connections = await testDb.db.select({ id: oauthConnections.id }).from(oauthConnections);
    expect(connections.map((row) => row.id)).toContain(liveConnection.id);
    expect(connections.map((row) => row.id)).not.toContain(expiredConnection.id);
  });

  it("are found through the expiry indexes", async () => {
    expect(
      await planWithoutSeqScan(sql`delete from oauth_states where expires_at <= now()`),
    ).toContain("oauth_states_expires_at_idx");
    expect(
      await planWithoutSeqScan(sql`delete from oauth_connections where expires_at <= now()`),
    ).toContain("oauth_connections_expires_at_idx");
  });
});
