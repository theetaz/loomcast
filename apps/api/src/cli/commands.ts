import {
  EmailSchema,
  MCP_TOKEN_SCOPES,
  NewPasswordSchema,
  type TokenScope,
  type UserRole,
  UserRoleSchema,
} from "@loomcast/contracts";
import { type Database, type UserRow, users } from "@loomcast/db";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { audit } from "../lib/audit";
import type { Clock } from "../lib/clock";
import { isUniqueViolation, transaction } from "../lib/db";
import { HttpError } from "../lib/errors";
import { hashPassword } from "../lib/password";
import { createSessionsService } from "../modules/auth/sessions";
import { createTokensService } from "../modules/tokens/service";

/** A refusal the CLI prints as is, without a stack trace. */
export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliError";
  }
}

export interface CommandDeps {
  db: Database;
  clock: Clock;
}

const NameSchema = z.string().trim().min(1).max(100);

function parseOrFail<S extends z.ZodType>(schema: S, value: unknown, label: string): z.output<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new CliError(`${label}: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
  }
  return parsed.data;
}

export function validatePassword(password: string): string {
  return parseOrFail(NewPasswordSchema, password, "Password");
}

export interface CreateUserInput {
  email: string;
  name: string;
  role: UserRole;
  password: string;
}

/**
 * Creates an account. The first account must be the owner, there is only one owner, and an admin
 * can only be created once the owner exists. Emails must be unused.
 */
export async function createUser(deps: CommandDeps, input: CreateUserInput): Promise<UserRow> {
  const email = parseOrFail(EmailSchema, input.email, "Email");
  const name = parseOrFail(NameSchema, input.name, "Name");
  const role = parseOrFail(UserRoleSchema, input.role, "Role");
  const passwordHash = await hashPassword(validatePassword(input.password));

  try {
    return await transaction(deps.db, async (tx) => {
      // Serialise account creation so two runs cannot both create "the first owner".
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('loomcast:create-user'))`);
      const [owner] = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.role, "owner"))
        .limit(1);
      if (role === "owner" && owner !== undefined) {
        throw new CliError("An owner already exists. Create an admin instead.");
      }
      if (role === "admin" && owner === undefined) {
        throw new CliError("Create the owner first: the first account must be the owner.");
      }
      const [existing] = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, email))
        .limit(1);
      if (existing !== undefined) {
        throw new CliError(`An account with the email ${email} already exists.`);
      }
      const [user] = await tx
        .insert(users)
        .values({ email, name, role, passwordHash, createdAt: deps.clock.now() })
        .returning();
      if (user === undefined) {
        throw new Error("user was not inserted");
      }
      await audit(tx, {
        actorKind: "system",
        action: "user.created",
        targetType: "user",
        targetId: user.id,
        data: { role, via: "cli" },
      });
      return user;
    });
  } catch (error) {
    if (isUniqueViolation(error, "users_email_uq")) {
      throw new CliError(`An account with the email ${email} already exists.`);
    }
    throw error;
  }
}

async function findUser(db: Database, rawEmail: string): Promise<UserRow> {
  const email = parseOrFail(EmailSchema, rawEmail, "Email");
  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (user === undefined) {
    throw new CliError(`No account with the email ${email}.`);
  }
  return user;
}

/** Parses `mcp:read,mcp:write` into MCP scopes. */
export function parseScopes(value: string): TokenScope[] {
  const scopes = value
    .split(",")
    .map((scope) => scope.trim())
    .filter((scope) => scope.length > 0);
  const allowed: readonly string[] = MCP_TOKEN_SCOPES;
  const unknown = scopes.filter((scope) => !allowed.includes(scope));
  if (scopes.length === 0 || unknown.length > 0) {
    throw new CliError(`Scopes must be a comma-separated list of: ${MCP_TOKEN_SCOPES.join(", ")}.`);
  }
  return scopes as TokenScope[];
}

export interface IssueTokenInput {
  email: string;
  name: string;
  scopes: TokenScope[];
}

/** Creates an MCP token for an account and returns the secret, which is shown once. */
export async function issueToken(
  deps: CommandDeps,
  input: IssueTokenInput,
): Promise<{ secret: string; prefix: string; scopes: TokenScope[] }> {
  const user = await findUser(deps.db, input.email);
  if (user.disabledAt !== null) {
    throw new CliError(`The account ${user.email} is disabled.`);
  }
  const tokens = createTokensService(deps);
  try {
    const created = await tokens.create({
      userId: user.id,
      kind: "mcp",
      name: input.name,
      scopes: input.scopes,
    });
    await audit(deps.db, {
      actorKind: "system",
      action: "token.created",
      targetType: "api_token",
      targetId: created.row.id,
      data: { kind: "mcp", name: created.row.name, scopes: created.row.scopes, via: "cli" },
    });
    return { secret: created.secret, prefix: created.row.prefix, scopes: created.row.scopes };
  } catch (error) {
    if (error instanceof HttpError) {
      throw new CliError(error.message);
    }
    throw error;
  }
}

/** Sets a new password and ends every session of the account. */
export async function resetPassword(
  deps: CommandDeps,
  input: { email: string; password: string },
): Promise<{ sessionsEnded: number }> {
  const user = await findUser(deps.db, input.email);
  const passwordHash = await hashPassword(validatePassword(input.password));
  const sessions = createSessionsService(deps);
  return transaction(deps.db, async (tx) => {
    await tx.update(users).set({ passwordHash }).where(eq(users.id, user.id));
    const sessionsEnded = await sessions.revokeAll(user.id, tx);
    await audit(tx, {
      actorKind: "system",
      action: "auth.password.reset",
      targetType: "user",
      targetId: user.id,
      data: { sessionsEnded, via: "cli" },
    });
    return { sessionsEnded };
  });
}
