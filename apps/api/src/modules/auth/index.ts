import {
  ChangePasswordRequestSchema,
  InspectPasswordTokenRequestSchema,
  LoginRequestSchema,
  type Me,
  type PasswordTokenInfo,
  routes,
  SetPasswordRequestSchema,
} from "@loomcast/contracts";
import { users } from "@loomcast/db";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { ModuleDeps } from "../../deps";
import { audit } from "../../lib/audit";
import { transaction } from "../../lib/db";
import { HttpError, notFound, validationFailed } from "../../lib/errors";
import { clientIp, readJson, userAgent } from "../../lib/http";
import { hashPassword, verifyDummyPassword, verifyPassword } from "../../lib/password";
import { consume, createRateLimiter } from "../../lib/rate-limit";
import type { AppEnv, AuthUser } from "../../types";
import { clearSessionCookie, setSessionCookie } from "./cookies";
import { currentSession, currentUser } from "./guards";
import { createPasswordTokensService } from "./password-tokens";
import { addUserRoutes, createUsersService } from "./users";

export {
  type AuthGuards,
  createAuthGuards,
  currentSession,
  currentToken,
  currentUser,
} from "./guards";
export {
  createPasswordTokensService,
  type PasswordTokensService,
  SET_PASSWORD_PATH,
  setPasswordUrl,
} from "./password-tokens";
export { createSessionsService, type SessionsService } from "./sessions";
export {
  createUsersService,
  toUserSummary,
  type UserActor,
  type UsersService,
} from "./users";

const MINUTE_MS = 60_000;

/** Login limits from the security model: 5 a minute per address and email, 20 per address. */
export const LOGIN_LIMITS = {
  perAccount: { capacity: 5, intervalMs: MINUTE_MS },
  perIp: { capacity: 20, intervalMs: MINUTE_MS },
} as const;

/** Password changes per user, so a stolen session cannot brute-force the current password. */
export const PASSWORD_CHANGE_LIMIT = { capacity: 5, intervalMs: MINUTE_MS } as const;

/** Set-password link requests (inspect and set-password together) per client address. */
export const PASSWORD_LINK_LIMIT = { capacity: 10, intervalMs: MINUTE_MS } as const;

const INVALID_LOGIN_MESSAGE = "Email or password is incorrect.";
const INVALID_LINK_MESSAGE = "This link is invalid, has expired or was already used.";

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

/**
 * `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`, `POST /api/auth/password`,
 * the public set-password routes (`POST /api/auth/password-tokens/inspect`,
 * `POST /api/auth/set-password`) and the owner's user routes (`/api/users`).
 */
export function register(app: Hono<AppEnv>, deps: ModuleDeps): Hono<AppEnv> {
  const { db, clock, config, sessions, tokens } = deps;
  const router = new Hono<AppEnv>();
  const loginPerIp = createRateLimiter(LOGIN_LIMITS.perIp, clock);
  const loginPerAccount = createRateLimiter(LOGIN_LIMITS.perAccount, clock);
  const passwordChanges = createRateLimiter(PASSWORD_CHANGE_LIMIT, clock);
  const passwordLinks = createRateLimiter(PASSWORD_LINK_LIMIT, clock);
  const passwordTokens = createPasswordTokensService({ db, clock, config });
  const usersService = createUsersService({ db, clock, sessions, tokens, passwordTokens });

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

  // Public routes: the token in the body is the credential. They apply the CSRF check themselves.
  router.post(routes["auth.inspectPasswordToken"].path, deps.auth.csrfGuard, async (c) => {
    const ip = clientIp(c, config.trustProxy);
    consume(passwordLinks, ip);
    const input = await readJson(c, InspectPasswordTokenRequestSchema);
    const found = await passwordTokens.find(input.token);
    c.header("Cache-Control", "no-store");
    if (found === null) {
      await audit(db, {
        actorKind: "user",
        action: "auth.password_token.invalid",
        data: { route: "inspect" },
        ip,
      });
      throw notFound(INVALID_LINK_MESSAGE);
    }
    await audit(db, {
      actorKind: "user",
      actorId: found.user.id,
      action: "auth.password_token.inspected",
      targetType: "user",
      targetId: found.user.id,
      data: { purpose: found.token.purpose },
      ip,
    });
    const body: PasswordTokenInfo = {
      email: found.user.email,
      purpose: found.token.purpose,
      expiresAt: found.token.expiresAt.toISOString(),
    };
    return c.json(body, 200);
  });

  // Sets the password and consumes the link. There is no automatic sign-in: every session of the
  // account ends, and the user signs in with the new password.
  router.post(routes["auth.setPassword"].path, deps.auth.csrfGuard, async (c) => {
    const ip = clientIp(c, config.trustProxy);
    consume(passwordLinks, ip);
    const input = await readJson(c, SetPasswordRequestSchema);
    c.header("Cache-Control", "no-store");

    const invalid = async () => {
      await audit(db, {
        actorKind: "user",
        action: "auth.password_token.invalid",
        data: { route: "set-password" },
        ip,
      });
      return notFound(INVALID_LINK_MESSAGE);
    };
    // Checked before the slow hash, and again under a row lock so a link is used only once.
    if ((await passwordTokens.find(input.token)) === null) {
      throw await invalid();
    }
    const passwordHash = await hashPassword(input.newPassword);
    const used = await transaction(db, async (tx) => {
      const found = await passwordTokens.find(input.token, tx);
      if (found === null) {
        return false;
      }
      const { token, user } = found;
      await tx.update(users).set({ passwordHash }).where(eq(users.id, user.id));
      await passwordTokens.markUsed(token.id, tx);
      await passwordTokens.voidUnused(user.id, tx);
      const sessionsEnded = await sessions.revokeAll(user.id, tx);
      await audit(tx, {
        actorKind: "user",
        actorId: user.id,
        action: "auth.password.set",
        targetType: "user",
        targetId: user.id,
        data: { purpose: token.purpose, sessionsEnded },
        ip,
      });
      return true;
    });
    if (!used) {
      throw await invalid();
    }
    return c.body(null, 204);
  });

  addUserRoutes(router, deps, usersService);

  app.route("/", router);
  return router;
}
