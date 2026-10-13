import {
  type AccessToken,
  DEVICE_TOKEN_RE,
  IdSchema,
  MCP_TOKEN_RE,
  MCP_TOKEN_SCOPES,
  TOKEN_NAME_MAX_LENGTH,
  type TokenKind,
  type TokenScope,
} from "@loomcast/contracts";
import { type ApiTokenRow, apiTokens, type Database, users } from "@loomcast/db";
import { and, desc, eq, gt, isNull, lte, or, type SQL } from "drizzle-orm";
import type { Clock } from "../../lib/clock";
import { generatePrefixedToken, sha256Hex } from "../../lib/crypto";
import type { Executor } from "../../lib/db";
import { badRequest, forbidden, validationFailed } from "../../lib/errors";
import type { VerifiedToken } from "../../types";

/** `last_used_at` is written at most once per this interval per token. */
export const LAST_USED_RESOLUTION_MS = 60_000;

/** Scopes each token kind may carry. */
export const ALLOWED_SCOPES: { readonly [K in TokenKind]: readonly TokenScope[] } = {
  mcp: MCP_TOKEN_SCOPES,
  device: ["bridge"],
};

/** Scopes only the owner's tokens may hold. */
export const OWNER_ONLY_SCOPES: readonly TokenScope[] = ["mcp:admin"];

const TOKEN_FORMAT: { readonly [K in TokenKind]: RegExp } = {
  mcp: MCP_TOKEN_RE,
  device: DEVICE_TOKEN_RE,
};

export interface CreateTokenInput {
  userId: string;
  kind: TokenKind;
  name: string;
  scopes: readonly TokenScope[];
  expiresAt?: Date | null;
}

export interface CreatedToken {
  row: ApiTokenRow;
  token: AccessToken;
  /** The bearer secret. Return it to the caller once; it is never stored or logged. */
  secret: string;
}

export interface RevokeOptions {
  /** Only revoke when the token belongs to this user. */
  userId?: string;
  /** Only revoke a token of this kind. */
  kind?: TokenKind;
  executor?: Executor;
}

export interface RevokeResult {
  row: ApiTokenRow;
  /** False when the token was already revoked. */
  revoked: boolean;
}

export interface TokensService {
  /**
   * Creates a token. Scopes must suit the kind, and `mcp:admin` requires the owner. Pass the
   * transaction when the token is created together with other rows (a paired device).
   */
  create(input: CreateTokenInput, executor?: Executor): Promise<CreatedToken>;
  /**
   * Checks a bearer secret: format, hash, kind, not revoked or expired, and the user not disabled.
   * Records `last_used_at` (at most once a minute). Returns null for anything unusable.
   */
  verify(raw: string, kind: TokenKind): Promise<VerifiedToken | null>;
  /** Revokes a token. Null when no token matches the id and options. */
  revoke(id: string, options?: RevokeOptions): Promise<RevokeResult | null>;
  /** The user's tokens of `kind` that are not revoked, newest first. */
  list(userId: string, kind: TokenKind): Promise<ApiTokenRow[]>;
}

export function toAccessToken(row: ApiTokenRow): AccessToken {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    prefix: row.prefix,
    scopes: row.scopes,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
  };
}

/** True when `token` carries every scope in `required`. */
export function hasScopes(token: Pick<VerifiedToken, "scopes">, required: readonly TokenScope[]) {
  return required.every((scope) => token.scopes.includes(scope));
}

export function createTokensService(deps: { db: Database; clock: Clock }): TokensService {
  const { db, clock } = deps;

  return {
    async create(input, executor = db) {
      const name = input.name.trim();
      if (name.length === 0 || name.length > TOKEN_NAME_MAX_LENGTH) {
        throw validationFailed([
          { path: "name", message: `Name must be 1 to ${TOKEN_NAME_MAX_LENGTH} characters` },
        ]);
      }
      const scopes = [...new Set(input.scopes)];
      const allowed = ALLOWED_SCOPES[input.kind];
      const invalid = scopes.filter((scope) => !allowed.includes(scope));
      if (scopes.length === 0 || invalid.length > 0) {
        throw validationFailed([
          {
            path: "scopes",
            message: `A ${input.kind} token takes one or more of: ${allowed.join(", ")}`,
          },
        ]);
      }
      const now = clock.now();
      if (input.expiresAt && input.expiresAt.getTime() <= now.getTime()) {
        throw validationFailed([{ path: "expiresAt", message: "Expiry must be in the future" }]);
      }

      const [user] = await executor
        .select({ role: users.role, disabledAt: users.disabledAt })
        .from(users)
        .where(eq(users.id, input.userId))
        .limit(1);
      if (user === undefined || user.disabledAt !== null) {
        throw badRequest("The token's user does not exist or is disabled.");
      }
      if (user.role !== "owner" && scopes.some((scope) => OWNER_ONLY_SCOPES.includes(scope))) {
        throw forbidden("Only the owner can create tokens with the mcp:admin scope.");
      }

      const generated = generatePrefixedToken(input.kind);
      const [row] = await executor
        .insert(apiTokens)
        .values({
          userId: input.userId,
          kind: input.kind,
          name,
          tokenHash: generated.hash,
          prefix: generated.prefix,
          scopes,
          expiresAt: input.expiresAt ?? null,
          createdAt: now,
        })
        .returning();
      if (row === undefined) {
        throw new Error("token was not inserted");
      }
      return { row, token: toAccessToken(row), secret: generated.secret };
    },

    async verify(raw, kind) {
      if (!TOKEN_FORMAT[kind].test(raw)) {
        return null;
      }
      const now = clock.now();
      const [found] = await db
        .select({ token: apiTokens, user: users })
        .from(apiTokens)
        .innerJoin(users, eq(users.id, apiTokens.userId))
        .where(
          and(
            eq(apiTokens.tokenHash, sha256Hex(raw)),
            eq(apiTokens.kind, kind),
            isNull(apiTokens.revokedAt),
            or(isNull(apiTokens.expiresAt), gt(apiTokens.expiresAt, now)),
            isNull(users.disabledAt),
          ),
        )
        .limit(1);
      if (found === undefined) {
        return null;
      }
      const { token, user } = found;

      const staleBefore = new Date(now.getTime() - LAST_USED_RESOLUTION_MS);
      if (token.lastUsedAt === null || token.lastUsedAt.getTime() <= staleBefore.getTime()) {
        await db
          .update(apiTokens)
          .set({ lastUsedAt: now })
          .where(
            and(
              eq(apiTokens.id, token.id),
              or(isNull(apiTokens.lastUsedAt), lte(apiTokens.lastUsedAt, staleBefore)),
            ),
          );
      }

      return {
        id: token.id,
        kind: token.kind,
        name: token.name,
        scopes:
          user.role === "owner"
            ? token.scopes
            : token.scopes.filter((scope) => !OWNER_ONLY_SCOPES.includes(scope)),
        user: { id: user.id, email: user.email, name: user.name, role: user.role },
      };
    },

    async revoke(id, options = {}) {
      if (!IdSchema.safeParse(id).success) {
        return null;
      }
      const executor = options.executor ?? db;
      const conditions: SQL[] = [eq(apiTokens.id, id)];
      if (options.userId !== undefined) {
        conditions.push(eq(apiTokens.userId, options.userId));
      }
      if (options.kind !== undefined) {
        conditions.push(eq(apiTokens.kind, options.kind));
      }
      const [revoked] = await executor
        .update(apiTokens)
        .set({ revokedAt: clock.now() })
        .where(and(...conditions, isNull(apiTokens.revokedAt)))
        .returning();
      if (revoked !== undefined) {
        return { row: revoked, revoked: true };
      }
      const [existing] = await executor
        .select()
        .from(apiTokens)
        .where(and(...conditions))
        .limit(1);
      return existing === undefined ? null : { row: existing, revoked: false };
    },

    async list(userId, kind) {
      return db
        .select()
        .from(apiTokens)
        .where(
          and(eq(apiTokens.userId, userId), eq(apiTokens.kind, kind), isNull(apiTokens.revokedAt)),
        )
        .orderBy(desc(apiTokens.createdAt));
    },
  };
}
