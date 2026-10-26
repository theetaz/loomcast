import type { HttpBindings } from "@hono/node-server";
import type { TokenKind, TokenScope, UserRole } from "@loomcast/contracts";
import type { Logger } from "./lib/logger";

/** The signed-in user of a cookie session. */
export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  createdAt: Date;
  lastLoginAt: Date | null;
}

/** The cookie session behind the current request. `id` is the sha256 of the cookie token. */
export interface AuthSession {
  id: string;
  userId: string;
  lastSeenAt: Date;
  expiresAt: Date;
}

/** A bearer token that passed `tokens.verify`. */
export interface VerifiedToken {
  id: string;
  kind: TokenKind;
  name: string;
  /**
   * Scopes in effect. `mcp:admin` is dropped when the token's user is no longer the owner, so a
   * demoted account cannot keep using owner-only tools.
   */
  scopes: TokenScope[];
  user: Pick<AuthUser, "id" | "email" | "name" | "role">;
  /** Set for job and API tokens only: the one workspace the token is bound to. */
  workspaceId?: string | null;
  /** Set for job tokens only: the job the token was minted for. */
  jobId?: string | null;
}

export interface AppVariables {
  /** Request-scoped child logger carrying the request id. */
  logger: Logger;
  /** Set by the session guard on cookie routes. */
  user: AuthUser | undefined;
  session: AuthSession | undefined;
  /** Set by `requireBearer` on `/mcp`, `/bridge` and `/api/v1`. */
  token: VerifiedToken | undefined;
}

/**
 * Hono environment of every route. `Bindings` holds the Node request and response when served by
 * `@hono/node-server`; they are absent under `app.request()` in tests.
 */
export interface AppEnv {
  Bindings: Partial<HttpBindings>;
  Variables: AppVariables;
}
