import {
  type InviteUserRequest,
  InviteUserRequestSchema,
  type InviteUserResponse,
  type PasswordLink,
  routes,
  type UserSummary,
} from "@loomcast/contracts";
import { type Database, type UserRow, users } from "@loomcast/db";
import { asc, eq, sql } from "drizzle-orm";
import type { Context, Hono } from "hono";
import type { ModuleDeps } from "../../deps";
import { audit } from "../../lib/audit";
import type { Clock } from "../../lib/clock";
import { isUniqueViolation, type Transaction, transaction } from "../../lib/db";
import { conflict, forbidden, notFound, validationFailed } from "../../lib/errors";
import { clientIp, idParam, readJson } from "../../lib/http";
import type { AppEnv, AuthUser } from "../../types";
import type { TokensService } from "../tokens/service";
import { currentUser } from "./guards";
import type { PasswordTokensService } from "./password-tokens";
import type { SessionsService } from "./sessions";

/**
 * Token kinds a disabled user loses. Device tokens stay with their device (devices are shared by
 * every signed-in user and are revoked from the devices page); `tokens.verify` already refuses the
 * tokens of a disabled user.
 */
const TOKEN_KINDS_REVOKED_ON_DISABLE = ["mcp", "job"] as const;

export function toUserSummary(row: UserRow): UserSummary {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    createdAt: row.createdAt.toISOString(),
    lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
    disabledAt: row.disabledAt?.toISOString() ?? null,
  };
}

/** Who asked for a change: a signed-in user (with their address), or the admin CLI. */
export type UserActor = { kind: "user"; id: string; ip: string | null } | { kind: "system" };

export interface UserWithLink {
  user: UserRow;
  /** Shown once. The secret is in the URL fragment and only its hash is stored. */
  link: PasswordLink;
}

export interface DisableResult {
  user: UserRow;
  /** False when the user was already disabled. */
  changed: boolean;
}

export interface UsersService {
  /** Every account, oldest first. */
  list(): Promise<UserRow[]>;
  /**
   * Creates an account without a password and returns its one-time invitation link. Only admins
   * are invited: there is a single owner. 409 when the email is taken.
   */
  invite(input: InviteUserRequest, actor: UserActor): Promise<UserWithLink>;
  /**
   * A new one-time reset link for an enabled account; the account's earlier links stop working.
   * Null when there is no such account.
   */
  resetLink(userId: string, actor: UserActor): Promise<UserWithLink | null>;
  /**
   * Disables an account and ends its sessions, MCP and job tokens and unused links. The owner
   * cannot be disabled. Null when there is no such account.
   */
  disable(userId: string, actor: UserActor): Promise<DisableResult | null>;
}

export interface UsersServiceDeps {
  db: Database;
  clock: Clock;
  sessions: SessionsService;
  tokens: Pick<TokensService, "revokeForUser">;
  passwordTokens: PasswordTokensService;
}

/** Serialises account creation (shared with the admin CLI), so the single-owner rule holds. */
export async function lockUserCreation(tx: Transaction): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('loomcast:create-user'))`);
}

function actorFields(actor: UserActor) {
  return actor.kind === "user"
    ? { actorKind: "user" as const, actorId: actor.id, ip: actor.ip }
    : { actorKind: "system" as const, actorId: null, ip: null };
}

export function createUsersService(deps: UsersServiceDeps): UsersService {
  const { db, clock, sessions, tokens, passwordTokens } = deps;

  async function inviteIn(
    tx: Transaction,
    input: InviteUserRequest,
    actor: UserActor,
  ): Promise<UserWithLink> {
    await lockUserCreation(tx);
    const [existing] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, input.email))
      .limit(1);
    if (existing !== undefined) {
      throw conflict("An account with this email already exists.");
    }
    const [user] = await tx
      .insert(users)
      .values({
        email: input.email,
        name: input.name,
        role: input.role,
        passwordHash: null,
        createdAt: clock.now(),
      })
      .returning();
    if (user === undefined) {
      throw new Error("user was not inserted");
    }
    const issued = await passwordTokens.issue(
      { userId: user.id, purpose: "invite", createdBy: actor.kind === "user" ? actor.id : null },
      tx,
    );
    await audit(tx, {
      ...actorFields(actor),
      action: "user.invited",
      targetType: "user",
      targetId: user.id,
      data: {
        email: user.email,
        role: user.role,
        expiresAt: issued.link.expiresAt,
        via: actor.kind === "user" ? "web" : "cli",
      },
    });
    return { user, link: issued.link };
  }

  return {
    list() {
      return db.select().from(users).orderBy(asc(users.createdAt), asc(users.id));
    },

    async invite(input, actor) {
      if (input.role === "owner") {
        throw validationFailed(
          [{ path: "role", message: "There is one owner; invite an admin instead" }],
          "Only admins can be invited.",
        );
      }
      try {
        return await transaction(db, (tx) => inviteIn(tx, input, actor));
      } catch (error) {
        if (isUniqueViolation(error, "users_email_uq")) {
          throw conflict("An account with this email already exists.");
        }
        throw error;
      }
    },

    resetLink(userId, actor) {
      return transaction(db, async (tx) => {
        const [user] = await tx
          .select()
          .from(users)
          .where(eq(users.id, userId))
          .limit(1)
          .for("update");
        if (user === undefined) {
          return null;
        }
        if (user.disabledAt !== null) {
          throw conflict("This account is disabled.");
        }
        const issued = await passwordTokens.issue(
          {
            userId: user.id,
            purpose: "reset",
            createdBy: actor.kind === "user" ? actor.id : null,
          },
          tx,
        );
        await audit(tx, {
          ...actorFields(actor),
          action: "user.reset_link.created",
          targetType: "user",
          targetId: user.id,
          data: { expiresAt: issued.link.expiresAt },
        });
        return { user, link: issued.link };
      });
    },

    disable(userId, actor) {
      return transaction(db, async (tx) => {
        const [user] = await tx
          .select()
          .from(users)
          .where(eq(users.id, userId))
          .limit(1)
          .for("update");
        if (user === undefined) {
          return null;
        }
        if (actor.kind === "user" && actor.id === user.id) {
          throw conflict("You cannot disable your own account.");
        }
        if (user.role === "owner") {
          throw conflict("The owner's account cannot be disabled.");
        }
        if (user.disabledAt !== null) {
          return { user, changed: false };
        }
        const [disabled] = await tx
          .update(users)
          .set({ disabledAt: clock.now() })
          .where(eq(users.id, user.id))
          .returning();
        if (disabled === undefined) {
          throw new Error("user was not updated");
        }
        const sessionsEnded = await sessions.revokeAll(user.id, tx);
        const tokensRevoked = await tokens.revokeForUser(
          user.id,
          TOKEN_KINDS_REVOKED_ON_DISABLE,
          tx,
        );
        const linksVoided = await passwordTokens.voidUnused(user.id, tx);
        await audit(tx, {
          ...actorFields(actor),
          action: "user.disabled",
          targetType: "user",
          targetId: user.id,
          data: { sessionsEnded, tokensRevoked, linksVoided },
        });
        return { user: disabled, changed: true };
      });
    },
  };
}

/** The signed-in user, who must be the owner. 403 otherwise. */
function currentOwner(c: Context<AppEnv>): AuthUser {
  const user = currentUser(c);
  if (user.role !== "owner") {
    throw forbidden("Only the owner can manage users.");
  }
  return user;
}

function toInviteResponse(result: UserWithLink): InviteUserResponse {
  return { user: toUserSummary(result.user), ...result.link };
}

/**
 * Owner-only user routes: `GET /api/users`, `POST /api/users/invitations`,
 * `POST /api/users/:id/reset-link` and `POST /api/users/:id/disable`. The app-level guard has
 * already required a session and passed the CSRF check.
 */
export function addUserRoutes(
  router: Hono<AppEnv>,
  deps: Pick<ModuleDeps, "config">,
  service: UsersService,
): void {
  const { config } = deps;
  const actorOf = (c: Context<AppEnv>, user: AuthUser): UserActor => ({
    kind: "user",
    id: user.id,
    ip: clientIp(c, config.trustProxy),
  });

  router.get(routes["users.list"].path, async (c) => {
    currentOwner(c);
    const rows = await service.list();
    c.header("Cache-Control", "no-store");
    return c.json({ items: rows.map(toUserSummary) }, 200);
  });

  router.post(routes["users.invite"].path, async (c) => {
    const owner = currentOwner(c);
    const input = await readJson(c, InviteUserRequestSchema);
    const result = await service.invite(input, actorOf(c, owner));
    // The link is in this response only; keep it out of every cache.
    c.header("Cache-Control", "no-store");
    return c.json(toInviteResponse(result), 201);
  });

  router.post(routes["users.resetLink"].path, async (c) => {
    const owner = currentOwner(c);
    const result = await service.resetLink(idParam(c), actorOf(c, owner));
    if (result === null) {
      throw notFound("User not found.");
    }
    c.header("Cache-Control", "no-store");
    return c.json(toInviteResponse(result), 201);
  });

  router.post(routes["users.disable"].path, async (c) => {
    const owner = currentOwner(c);
    const result = await service.disable(idParam(c), actorOf(c, owner));
    if (result === null) {
      throw notFound("User not found.");
    }
    return c.json(toUserSummary(result.user), 200);
  });
}
