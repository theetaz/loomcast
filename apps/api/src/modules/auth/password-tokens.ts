import {
  PASSWORD_TOKEN_RE,
  PASSWORD_TOKEN_TTL_MS,
  type PasswordLink,
  type PasswordTokenPurpose,
} from "@loomcast/contracts";
import {
  type Database,
  type PasswordTokenRow,
  passwordTokens,
  type UserRow,
  users,
} from "@loomcast/db";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { Config } from "../../env";
import type { Clock } from "../../lib/clock";
import { randomToken, sha256Hex } from "../../lib/crypto";
import type { Executor, Transaction } from "../../lib/db";

/** Path of the web page that takes a set-password link. */
export const SET_PASSWORD_PATH = "/set-password";

/** Random bytes in a set-password token: 32 bytes are 43 base64url characters. */
const TOKEN_BYTES = 32;

export interface IssuePasswordTokenInput {
  userId: string;
  purpose: PasswordTokenPurpose;
  /** The user who asked for the link; null for the admin CLI. */
  createdBy: string | null;
}

export interface IssuedPasswordToken {
  row: PasswordTokenRow;
  /**
   * The link to hand over, with the secret in the URL fragment so it never reaches a server log.
   * It is returned once; only the secret's sha256 is stored.
   */
  link: PasswordLink;
}

/** A usable set-password token and its account. */
export interface ActivePasswordToken {
  token: PasswordTokenRow;
  user: UserRow;
}

export interface PasswordTokensService {
  /**
   * Issues a one-time set-password link. The user's unused links are voided first, so only the
   * newest link works. Invitations last `PASSWORD_TOKEN_TTL_MS.invite`, resets
   * `PASSWORD_TOKEN_TTL_MS.reset`. Pass the transaction that creates or changes the user.
   */
  issue(input: IssuePasswordTokenInput, executor?: Executor): Promise<IssuedPasswordToken>;
  /**
   * The token's row and account when the secret is well formed, unused, unexpired and its account
   * is enabled; otherwise null. With a transaction, the token row is locked (`FOR UPDATE`).
   */
  find(raw: string, tx?: Transaction): Promise<ActivePasswordToken | null>;
  /** Marks a token used. */
  markUsed(tokenId: string, executor?: Executor): Promise<void>;
  /** Voids every unused link of the user. Returns how many were voided. */
  voidUnused(userId: string, executor?: Executor): Promise<number>;
}

/** The set-password URL for a raw token: `${APP_ORIGIN}/set-password#token=…`. */
export function setPasswordUrl(config: Pick<Config, "appOrigin">, raw: string): string {
  const url = new URL(SET_PASSWORD_PATH, config.appOrigin);
  url.hash = `token=${raw}`;
  return url.toString();
}

export function createPasswordTokensService(deps: {
  db: Database;
  clock: Clock;
  config: Pick<Config, "appOrigin">;
}): PasswordTokensService {
  const { db, clock, config } = deps;

  async function voidUnused(userId: string, executor: Executor = db): Promise<number> {
    const removed = await executor
      .delete(passwordTokens)
      .where(and(eq(passwordTokens.userId, userId), isNull(passwordTokens.usedAt)))
      .returning({ id: passwordTokens.id });
    return removed.length;
  }

  return {
    async issue(input, executor = db) {
      await voidUnused(input.userId, executor);
      const raw = randomToken(TOKEN_BYTES);
      const now = clock.now();
      const expiresAt = new Date(now.getTime() + PASSWORD_TOKEN_TTL_MS[input.purpose]);
      const [row] = await executor
        .insert(passwordTokens)
        .values({
          userId: input.userId,
          tokenHash: sha256Hex(raw),
          purpose: input.purpose,
          createdBy: input.createdBy,
          expiresAt,
          createdAt: now,
        })
        .returning();
      if (row === undefined) {
        throw new Error("password token was not inserted");
      }
      return {
        row,
        link: { setPasswordUrl: setPasswordUrl(config, raw), expiresAt: expiresAt.toISOString() },
      };
    },

    async find(raw, tx) {
      if (!PASSWORD_TOKEN_RE.test(raw)) {
        return null;
      }
      const executor = tx ?? db;
      const query = executor
        .select({ token: passwordTokens, user: users })
        .from(passwordTokens)
        .innerJoin(users, eq(users.id, passwordTokens.userId))
        .where(
          and(
            eq(passwordTokens.tokenHash, sha256Hex(raw)),
            isNull(passwordTokens.usedAt),
            gt(passwordTokens.expiresAt, clock.now()),
            isNull(users.disabledAt),
          ),
        )
        .limit(1);
      const [found] =
        tx === undefined ? await query : await query.for("update", { of: passwordTokens });
      return found ?? null;
    },

    async markUsed(tokenId, executor = db) {
      await executor
        .update(passwordTokens)
        .set({ usedAt: clock.now() })
        .where(eq(passwordTokens.id, tokenId));
    },

    voidUnused,
  };
}
