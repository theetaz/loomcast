import {
  ChangePasswordRequestSchema,
  LoginRequestSchema,
  type Me,
  routes,
} from "@loomcast/contracts";
import { users } from "@loomcast/db";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { ModuleDeps } from "../../deps";
import { audit } from "../../lib/audit";
import { transaction } from "../../lib/db";
import { HttpError, validationFailed } from "../../lib/errors";
import { clientIp, readJson, userAgent } from "../../lib/http";
import { hashPassword, verifyDummyPassword, verifyPassword } from "../../lib/password";
import { consume, createRateLimiter } from "../../lib/rate-limit";
import type { AppEnv, AuthUser } from "../../types";
import { clearSessionCookie, setSessionCookie } from "./cookies";
import { currentSession, currentUser } from "./guards";

export {
  type AuthGuards,
  createAuthGuards,
  currentSession,
  currentToken,
  currentUser,
} from "./guards";
export { createSessionsService, type SessionsService } from "./sessions";

const MINUTE_MS = 60_000;

/** Login limits from the security model: 5 a minute per address and email, 20 per address. */
export const LOGIN_LIMITS = {
  perAccount: { capacity: 5, intervalMs: MINUTE_MS },
  perIp: { capacity: 20, intervalMs: MINUTE_MS },
} as const;

/** Password changes per user, so a stolen session cannot brute-force the current password. */
export const PASSWORD_CHANGE_LIMIT = { capacity: 5, intervalMs: MINUTE_MS } as const;

const INVALID_LOGIN_MESSAGE = "Email or password is incorrect.";

export function toMe(user: AuthUser): Me {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    createdAt: user.createdAt.toISOString(),
    lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
  };
}

/** `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`, `POST /api/auth/password`. */
export function register(app: Hono<AppEnv>, deps: ModuleDeps): Hono<AppEnv> {
  const { db, clock, config, sessions } = deps;
  const router = new Hono<AppEnv>();
  const loginPerIp = createRateLimiter(LOGIN_LIMITS.perIp, clock);
  const loginPerAccount = createRateLimiter(LOGIN_LIMITS.perAccount, clock);
  const passwordChanges = createRateLimiter(PASSWORD_CHANGE_LIMIT, clock);

  // Public route: the app-level session guard lets it through, so it applies the CSRF check itself.
  router.post(routes["auth.login"].path, deps.auth.csrfGuard, async (c) => {
    const ip = clientIp(c, config.trustProxy);
    consume(loginPerIp, ip);
    const input = await readJson(c, LoginRequestSchema);
    consume(loginPerAccount, `${ip}\n${input.email}`);

    const [user] = await db.select().from(users).where(eq(users.email, input.email)).limit(1);
    const usable = user !== undefined && user.disabledAt === null;
    const valid = usable
      ? await verifyPassword(user.passwordHash, input.password)
      : await verifyDummyPassword(input.password);

    if (!usable || !valid) {
      await audit(db, {
        actorKind: "user",
        actorId: user?.id ?? null,
        action: "auth.login.failed",
        targetType: "user",
        targetId: user?.id ?? null,
        data: {
          email: input.email,
          reason: user === undefined ? "unknown_email" : usable ? "wrong_password" : "disabled",
        },
        ip,
      });
      c.get("logger").info({ userId: user?.id ?? null }, "login failed");
      // One answer for an unknown email, a disabled account and a wrong password.
      throw new HttpError(401, "unauthorized", INVALID_LOGIN_MESSAGE);
    }

    const now = clock.now();
    const { token, session } = await transaction(db, async (tx) => {
      const created = await sessions.create({ userId: user.id, ip, userAgent: userAgent(c) }, tx);
      await sessions.pruneExpired(user.id, tx);
      await tx.update(users).set({ lastLoginAt: now }).where(eq(users.id, user.id));
      await audit(tx, {
        actorKind: "user",
        actorId: user.id,
        action: "auth.login.succeeded",
        targetType: "user",
        targetId: user.id,
        ip,
      });
      return created;
    });

    setSessionCookie(c, config, token, session.expiresAt, now);
    c.header("Cache-Control", "no-store");
    return c.json(toMe({ ...user, lastLoginAt: now }), 200);
  });

  router.post(routes["auth.logout"].path, async (c) => {
    const user = currentUser(c);
    const session = currentSession(c);
    await sessions.revoke(session.id);
    await audit(db, {
      actorKind: "user",
      actorId: user.id,
      action: "auth.logout",
      targetType: "user",
      targetId: user.id,
      ip: clientIp(c, config.trustProxy),
    });
    clearSessionCookie(c, config);
    return c.body(null, 204);
  });

  router.get(routes["auth.me"].path, (c) => {
    c.header("Cache-Control", "no-store");
    return c.json(toMe(currentUser(c)), 200);
  });

  router.post(routes["auth.changePassword"].path, async (c) => {
    const user = currentUser(c);
    const session = currentSession(c);
    const ip = clientIp(c, config.trustProxy);
    consume(passwordChanges, user.id);
    const input = await readJson(c, ChangePasswordRequestSchema);

    const [row] = await db
      .select({ passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1);
    if (row === undefined || !(await verifyPassword(row.passwordHash, input.currentPassword))) {
      await audit(db, {
        actorKind: "user",
        actorId: user.id,
        action: "auth.password.change_failed",
        targetType: "user",
        targetId: user.id,
        ip,
      });
      throw validationFailed(
        [{ path: "currentPassword", message: "The current password is incorrect" }],
        "The current password is incorrect.",
      );
    }

    const passwordHash = await hashPassword(input.newPassword);
    await transaction(db, async (tx) => {
      await tx.update(users).set({ passwordHash }).where(eq(users.id, user.id));
      const ended = await sessions.revokeOthers(user.id, session.id, tx);
      await audit(tx, {
        actorKind: "user",
        actorId: user.id,
        action: "auth.password.changed",
        targetType: "user",
        targetId: user.id,
        data: { sessionsEnded: ended },
        ip,
      });
    });
    return c.body(null, 204);
  });

  app.route("/", router);
  return router;
}
