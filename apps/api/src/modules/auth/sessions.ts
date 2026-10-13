import { type Database, sessions, users } from "@loomcast/db";
import { and, eq, lte, ne } from "drizzle-orm";
import type { Clock } from "../../lib/clock";
import { randomToken, sha256Hex } from "../../lib/crypto";
import type { Executor } from "../../lib/db";
import type { AuthSession, AuthUser } from "../../types";

/** Sessions last 30 days and slide: activity pushes the expiry out again. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Activity renews a session (new expiry, re-issued cookie) at most this often, so a busy client
 * does not write to the database on every request.
 */
export const SESSION_RENEW_INTERVAL_MS = 10 * 60 * 1000;

/** Session cookies are 32 random bytes in base64url. */
const SESSION_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export interface CreateSessionInput {
  userId: string;
  ip: string | null;
  userAgent: string | null;
}

export interface ResolvedSession {
  user: AuthUser;
  session: AuthSession;
  /** True when this lookup extended the session; the caller re-issues the cookie. */
  renewed: boolean;
}

export interface SessionsService {
  /** Creates a session and returns the cookie token. Only its sha256 is stored. */
  create(
    input: CreateSessionInput,
    executor?: Executor,
  ): Promise<{ token: string; session: AuthSession }>;
  /**
   * Looks up the session for a cookie token. Expired sessions and sessions of disabled users are
   * deleted and resolve to null. Renews the session when `SESSION_RENEW_INTERVAL_MS` has passed.
   */
  resolve(token: string): Promise<ResolvedSession | null>;
  revoke(sessionId: string, executor?: Executor): Promise<void>;
  /** Ends every session of the user except `keepSessionId`. Returns how many ended. */
  revokeOthers(userId: string, keepSessionId: string, executor?: Executor): Promise<number>;
  revokeAll(userId: string, executor?: Executor): Promise<number>;
  /** Deletes the user's expired sessions. */
  pruneExpired(userId: string, executor?: Executor): Promise<void>;
}

export function sessionIdFor(token: string): string {
  return sha256Hex(token);
}

export function createSessionsService(deps: { db: Database; clock: Clock }): SessionsService {
  const { db, clock } = deps;

  return {
    async create(input, executor = db) {
      const token = randomToken(32);
      const now = clock.now();
      const [row] = await executor
        .insert(sessions)
        .values({
          id: sessionIdFor(token),
          userId: input.userId,
          createdAt: now,
          lastSeenAt: now,
          expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
          ip: input.ip,
          userAgent: input.userAgent,
        })
        .returning();
      if (row === undefined) {
        throw new Error("session was not inserted");
      }
      return {
        token,
        session: {
          id: row.id,
          userId: row.userId,
          lastSeenAt: row.lastSeenAt,
          expiresAt: row.expiresAt,
        },
      };
    },

    async resolve(token) {
      if (!SESSION_TOKEN_RE.test(token)) {
        return null;
      }
      const id = sessionIdFor(token);
      const [row] = await db
        .select({ session: sessions, user: users })
        .from(sessions)
        .innerJoin(users, eq(users.id, sessions.userId))
        .where(eq(sessions.id, id))
        .limit(1);
      if (row === undefined) {
        return null;
      }
      const now = clock.now();
      if (row.session.expiresAt.getTime() <= now.getTime() || row.user.disabledAt !== null) {
        await db.delete(sessions).where(eq(sessions.id, id));
        return null;
      }

      let { lastSeenAt, expiresAt } = row.session;
      let renewed = false;
      if (now.getTime() - lastSeenAt.getTime() >= SESSION_RENEW_INTERVAL_MS) {
        lastSeenAt = now;
        expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
        await db.update(sessions).set({ lastSeenAt, expiresAt }).where(eq(sessions.id, id));
        renewed = true;
      }

      const { user } = row;
      return {
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          createdAt: user.createdAt,
          lastLoginAt: user.lastLoginAt,
        },
        session: { id, userId: user.id, lastSeenAt, expiresAt },
        renewed,
      };
    },

    async revoke(sessionId, executor = db) {
      await executor.delete(sessions).where(eq(sessions.id, sessionId));
    },

    async revokeOthers(userId, keepSessionId, executor = db) {
      const removed = await executor
        .delete(sessions)
        .where(and(eq(sessions.userId, userId), ne(sessions.id, keepSessionId)))
        .returning({ id: sessions.id });
      return removed.length;
    },

    async revokeAll(userId, executor = db) {
      const removed = await executor
        .delete(sessions)
        .where(eq(sessions.userId, userId))
        .returning({ id: sessions.id });
      return removed.length;
    },

    async pruneExpired(userId, executor = db) {
      await executor
        .delete(sessions)
        .where(and(eq(sessions.userId, userId), lte(sessions.expiresAt, clock.now())));
    },
  };
}
