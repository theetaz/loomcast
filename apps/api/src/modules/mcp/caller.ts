import { TERMINAL_JOB_STATUSES, TOKEN_PREFIXES, type TokenKind } from "@loomcast/contracts";
import { apiTokens, jobs } from "@loomcast/db";
import { and, eq, notInArray } from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import type { ModuleDeps } from "../../deps";
import { unauthorized } from "../../lib/errors";
import { clientIp } from "../../lib/http";
import type { AppEnv, VerifiedToken } from "../../types";
import { currentToken } from "../auth/guards";

/** Who is calling the MCP server: a verified bearer token and what it is bound to. */
export interface McpCaller {
  token: VerifiedToken;
  /**
   * The only workspace the token may touch, or null when it is not bound to one. User MCP tokens
   * (`lc_mcp_…`) are never bound; job tokens (`lc_job_…`) are bound to their job's workspace.
   */
  boundWorkspaceId: string | null;
  /** The job a job token was minted for; null for user MCP tokens. */
  jobId: string | null;
  /** Client address, for audit rows. */
  ip: string;
}

/** What a token kind adds to the verified token. Null refuses the token (401). */
export interface CallerBinding {
  boundWorkspaceId: string | null;
  jobId: string | null;
}

/**
 * How one token kind is accepted on `/mcp`. The endpoint picks the resolver whose prefix the bearer
 * secret carries, verifies the secret with `requireBearer(kind)` (format, hash, kind, not revoked
 * or expired, user enabled) and then asks `bind` what the token is tied to. The tool registry
 * enforces each contract's `jobTokens` and `workspaceBinding` rules from the binding.
 */
export interface CallerResolver {
  kind: TokenKind;
  bind(token: VerifiedToken, deps: ModuleDeps): Promise<CallerBinding | null>;
}

const userTokenResolver: CallerResolver = {
  kind: "mcp",
  bind: async () => ({ boundWorkspaceId: null, jobId: null }),
};

/**
 * Job tokens (`lc_job_…`) are minted for one job and carry its workspace and job ids. They stop
 * working once the job has finished, even if revoking them at the end of the job was missed.
 */
const jobTokenResolver: CallerResolver = {
  kind: "job",
  async bind(token, deps) {
    const [row] = await deps.db
      .select({ workspaceId: apiTokens.workspaceId, jobId: apiTokens.jobId })
      .from(apiTokens)
      .innerJoin(jobs, eq(jobs.id, apiTokens.jobId))
      .where(and(eq(apiTokens.id, token.id), notInArray(jobs.status, [...TERMINAL_JOB_STATUSES])))
      .limit(1);
    if (row === undefined || row.workspaceId === null || row.jobId === null) {
      return null;
    }
    return { boundWorkspaceId: row.workspaceId, jobId: row.jobId };
  },
};

/** Token kinds accepted on `/mcp`: user MCP tokens and job tokens. */
export const CALLER_RESOLVERS: readonly CallerResolver[] = [userTokenResolver, jobTokenResolver];

const BEARER_PREFIX_RE = /^Bearer[ \t]+(\S+)/i;

/**
 * The resolver for the request's bearer secret, chosen by its prefix. Secrets without a known
 * prefix go to the user-token resolver, whose verification turns them away with the usual 401.
 */
export function resolverFor(
  authorization: string | undefined,
  resolvers: readonly CallerResolver[] = CALLER_RESOLVERS,
): CallerResolver {
  const raw = BEARER_PREFIX_RE.exec(authorization ?? "")?.[1] ?? "";
  return (
    resolvers.find((resolver) => raw.startsWith(TOKEN_PREFIXES[resolver.kind])) ?? userTokenResolver
  );
}

/**
 * Bearer authentication for `/mcp`: verifies the token with `requireBearer` for its kind, so
 * cookies are never read, and refuses a token its resolver cannot bind.
 */
export function requireMcpCaller(
  deps: ModuleDeps,
  resolvers: readonly CallerResolver[] = CALLER_RESOLVERS,
): MiddlewareHandler<AppEnv> {
  const guards = new Map<TokenKind, MiddlewareHandler<AppEnv>>();
  for (const resolver of [userTokenResolver, ...resolvers]) {
    guards.set(resolver.kind, deps.auth.requireBearer(resolver.kind));
  }
  return async (c, next) => {
    const { kind } = resolverFor(c.req.header("authorization"), resolvers);
    const guard = guards.get(kind) ?? deps.auth.requireBearer(kind);
    await guard(c, next);
  };
}

/** The caller of an authenticated `/mcp` request. Throws 401 when the token cannot be bound. */
export async function resolveCaller(
  c: Context<AppEnv>,
  deps: ModuleDeps,
  resolvers: readonly CallerResolver[] = CALLER_RESOLVERS,
): Promise<McpCaller> {
  const token = currentToken(c);
  const resolver =
    resolvers.find((candidate) => candidate.kind === token.kind) ??
    (token.kind === userTokenResolver.kind ? userTokenResolver : undefined);
  const binding = resolver === undefined ? null : await resolver.bind(token, deps);
  if (binding === null) {
    throw unauthorized("The token is invalid, expired or revoked.", {
      "WWW-Authenticate": 'Bearer realm="loomcast", error="invalid_token"',
    });
  }
  return { token, ...binding, ip: clientIp(c, deps.config.trustProxy) };
}
