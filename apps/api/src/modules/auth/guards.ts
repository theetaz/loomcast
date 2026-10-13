import type { Context, MiddlewareHandler } from "hono";
import type { Config } from "../../env";
import type { Clock } from "../../lib/clock";
import { HttpError, unauthorized } from "../../lib/errors";
import type { AppEnv, AuthSession, AuthUser } from "../../types";
import { clearSessionCookie, readSessionCookie, setSessionCookie } from "./cookies";
import type { SessionsService } from "./sessions";

const SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);

export interface AuthGuards {
  /**
   * Unsafe methods must come from the app's origin (`Origin` equal to `APP_ORIGIN`, or no `Origin`
   * and `Sec-Fetch-Site: same-origin`) and carry `Content-Type: application/json`. Else 403.
   */
  csrfGuard: MiddlewareHandler<AppEnv>;
  /** Requires a cookie session and sets `user` and `session`. Renews the session as it slides. */
  requireUser: MiddlewareHandler<AppEnv>;
  /** `csrfGuard` then `requireUser`: what every `auth: "session"` route gets. */
  sessionGuard: MiddlewareHandler<AppEnv>;
}

export interface AuthGuardDeps {
  config: Config;
  clock: Clock;
  sessions: SessionsService;
}

export function createAuthGuards(deps: AuthGuardDeps): AuthGuards {
  const { config, clock, sessions } = deps;

  function checkCsrf(c: Context<AppEnv>): void {
    if (SAFE_METHODS.has(c.req.method)) {
      return;
    }
    const origin = c.req.header("origin");
    const sameOrigin =
      origin === undefined
        ? c.req.header("sec-fetch-site") === "same-origin"
        : origin === config.appOrigin;
    if (!sameOrigin) {
      throw new HttpError(403, "forbidden", "Cross-site requests are not allowed.", {
        reason: "origin",
      });
    }
    const contentType = c.req.header("content-type")?.split(";")[0]?.trim().toLowerCase();
    if (contentType !== "application/json") {
      throw new HttpError(403, "forbidden", "Requests must be sent as application/json.", {
        reason: "content_type",
      });
    }
  }

  async function authenticate(c: Context<AppEnv>): Promise<void> {
    if (c.get("user") !== undefined) {
      return;
    }
    const token = readSessionCookie(c, config);
    if (token === undefined || token === "") {
      throw unauthorized();
    }
    const resolved = await sessions.resolve(token);
    if (resolved === null) {
      clearSessionCookie(c, config);
      throw unauthorized("Your session has ended. Sign in again.");
    }
    c.set("user", resolved.user);
    c.set("session", resolved.session);
    if (resolved.renewed) {
      setSessionCookie(c, config, token, resolved.session.expiresAt, clock.now());
    }
  }

  return {
    csrfGuard: async (c, next) => {
      checkCsrf(c);
      await next();
    },
    requireUser: async (c, next) => {
      await authenticate(c);
      await next();
    },
    sessionGuard: async (c, next) => {
      checkCsrf(c);
      await authenticate(c);
      await next();
    },
  };
}

/** The signed-in user. Throws 401 when the route was reached without a session. */
export function currentUser(c: Context<AppEnv>): AuthUser {
  const user = c.get("user");
  if (user === undefined) {
    throw unauthorized();
  }
  return user;
}

export function currentSession(c: Context<AppEnv>): AuthSession {
  const session = c.get("session");
  if (session === undefined) {
    throw unauthorized();
  }
  return session;
}
