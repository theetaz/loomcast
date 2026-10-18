import {
  type ApiChannelAccess,
  type ApiChannelGrant,
  type ApiClient,
  type CreateApiClientRequest,
  IdSchema,
  type UpdateApiClientRequest,
} from "@loomcast/contracts";
import {
  type ApiTokenRow,
  apiTokenChannels,
  apiTokens,
  channels,
  type Database,
  projects,
  users,
} from "@loomcast/db";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import type { Clock } from "../../lib/clock";
import { generatePrefixedToken } from "../../lib/crypto";
import { type Executor, type Transaction, transaction } from "../../lib/db";
import { conflict, forbidden, validationFailed } from "../../lib/errors";
import { requireActiveProject } from "../kb/service";

// API clients: `api` tokens of the owner, each bound to one project and granted channels with an
// access level. The machine API (`modules/api-v1`) reads the grants on every request, so a change
// here applies to the client's next call; revoking the token stops it at once.

export interface CreatedApiClient {
  client: ApiClient;
  row: ApiTokenRow;
  /** The API key. Return it to the caller once; it is never stored or logged. */
  secret: string;
}

export interface ApiClientChange {
  client: ApiClient;
  /** What changed, for the audit log: the old and new name, and the old and new grants. */
  changes: {
    name?: { from: string; to: string };
    grants?: { from: ApiChannelGrant[]; to: ApiChannelGrant[] };
  };
}

export interface ApiClientsService {
  /** Every API client, revoked ones included, newest first. */
  list(): Promise<ApiClient[]>;
  /** One client, or null. */
  get(id: string): Promise<ApiClient | null>;
  /**
   * Creates a client for `ownerId`, who must be the owner: the token and its grants in one
   * transaction. 404 for an unknown project and 409 for an archived one; 400 for a channel that
   * does not exist or an expiry in the past.
   */
  create(input: CreateApiClientRequest, ownerId: string): Promise<CreatedApiClient>;
  /** Renames a client or replaces its grants. 409 once revoked; null for no such client. */
  update(id: string, input: UpdateApiClientRequest): Promise<ApiClientChange | null>;
  /** Revokes a client. `revoked` is false when it already was; null for no such client. */
  revoke(id: string): Promise<{ client: ApiClient; revoked: boolean } | null>;
  /** The client's grants by channel id. */
  grants(tokenId: string, executor?: Executor): Promise<Map<string, ApiChannelAccess>>;
}

export interface ApiClientsServiceDeps {
  db: Database;
  clock: Clock;
}

/** The grants of each token, with the channel each names, by channel name. */
async function loadGrants(executor: Executor, tokenIds: readonly string[]) {
  if (tokenIds.length === 0) {
    return new Map<string, ApiClient["grants"]>();
  }
  const rows = await executor
    .select({
      tokenId: apiTokenChannels.tokenId,
      channelId: apiTokenChannels.channelId,
      access: apiTokenChannels.access,
      platform: channels.platform,
      channelName: channels.displayName,
    })
    .from(apiTokenChannels)
    .innerJoin(channels, eq(channels.id, apiTokenChannels.channelId))
    .where(inArray(apiTokenChannels.tokenId, [...tokenIds]))
    .orderBy(asc(channels.platform), asc(channels.displayName), asc(channels.id));
  const byToken = new Map<string, ApiClient["grants"]>();
  for (const { tokenId, ...grant } of rows) {
    const list = byToken.get(tokenId) ?? [];
    list.push(grant);
    byToken.set(tokenId, list);
  }
  return byToken;
}

async function loadClients(executor: Executor, ids?: readonly string[]): Promise<ApiClient[]> {
  const rows = await executor
    .select({ token: apiTokens, projectName: projects.name })
    .from(apiTokens)
    .innerJoin(projects, eq(projects.id, apiTokens.projectId))
    .where(
      and(
        eq(apiTokens.kind, "api"),
        ids === undefined ? undefined : inArray(apiTokens.id, [...ids]),
      ),
    )
    .orderBy(desc(apiTokens.createdAt), desc(apiTokens.id));
  const grants = await loadGrants(
    executor,
    rows.map((row) => row.token.id),
  );
  return rows.map(({ token, projectName }) => ({
    id: token.id,
    name: token.name,
    prefix: token.prefix,
    // Every API token has a project (`api_tokens_project_id_ck`).
    projectId: token.projectId ?? "",
    projectName,
    grants: grants.get(token.id) ?? [],
    createdAt: token.createdAt.toISOString(),
    lastUsedAt: token.lastUsedAt?.toISOString() ?? null,
    expiresAt: token.expiresAt?.toISOString() ?? null,
    revokedAt: token.revokedAt?.toISOString() ?? null,
  }));
}

/** 400 unless every granted channel exists. */
async function requireChannels(tx: Transaction, grants: readonly ApiChannelGrant[]): Promise<void> {
  const ids = grants.map((grant) => grant.channelId);
  const found = await tx
    .select({ id: channels.id })
    .from(channels)
    .where(inArray(channels.id, ids))
    .for("share");
  const known = new Set(found.map((row) => row.id));
  const missing = grants
    .map((grant, index) => ({ grant, index }))
    .filter(({ grant }) => !known.has(grant.channelId))
    .map(({ index }) => ({ path: `grants.${index}.channelId`, message: "No channel has that id" }));
  if (missing.length > 0) {
    throw validationFailed(missing);
  }
}

async function writeGrants(
  tx: Transaction,
  tokenId: string,
  grants: readonly ApiChannelGrant[],
  now: Date,
): Promise<void> {
  await tx.delete(apiTokenChannels).where(eq(apiTokenChannels.tokenId, tokenId));
  await tx.insert(apiTokenChannels).values(
    grants.map((grant) => ({
      tokenId,
      channelId: grant.channelId,
      access: grant.access,
      createdAt: now,
    })),
  );
}

function plainGrants(grants: ApiClient["grants"]): ApiChannelGrant[] {
  return grants.map(({ channelId, access }) => ({ channelId, access }));
}

export function createApiClientsService(deps: ApiClientsServiceDeps): ApiClientsService {
  const { db, clock } = deps;

  async function one(executor: Executor, id: string): Promise<ApiClient | null> {
    if (!IdSchema.safeParse(id).success) {
      return null;
    }
    const [client] = await loadClients(executor, [id]);
    return client ?? null;
  }

  return {
    list: () => loadClients(db),

    get: (id) => one(db, id),

    async create(input, ownerId) {
      const now = clock.now();
      if (input.expiresAt !== undefined && Date.parse(input.expiresAt) <= now.getTime()) {
        throw validationFailed([{ path: "expiresAt", message: "Expiry must be in the future" }]);
      }
      const generated = generatePrefixedToken("api");
      return transaction(db, async (tx) => {
        const [owner] = await tx
          .select({ role: users.role, disabledAt: users.disabledAt })
          .from(users)
          .where(eq(users.id, ownerId))
          .limit(1);
        if (owner === undefined || owner.role !== "owner" || owner.disabledAt !== null) {
          throw forbidden("Only the owner can create API clients.");
        }
        await requireActiveProject(tx, input.projectId);
        await requireChannels(tx, input.grants);
        const [row] = await tx
          .insert(apiTokens)
          .values({
            userId: ownerId,
            kind: "api",
            name: input.name,
            tokenHash: generated.hash,
            prefix: generated.prefix,
            scopes: [],
            projectId: input.projectId,
            expiresAt: input.expiresAt === undefined ? null : new Date(input.expiresAt),
            createdAt: now,
          })
          .returning();
        if (row === undefined) {
          throw new Error("API client was not inserted");
        }
        await writeGrants(tx, row.id, input.grants, now);
        const client = await one(tx, row.id);
        if (client === null) {
          throw new Error("API client vanished after insert");
        }
        return { client, row, secret: generated.secret };
      });
    },

    async update(id, input) {
      if (!IdSchema.safeParse(id).success) {
        return null;
      }
      return transaction(db, async (tx) => {
        const [row] = await tx
          .select()
          .from(apiTokens)
          .where(and(eq(apiTokens.id, id), eq(apiTokens.kind, "api")))
          .limit(1)
          .for("update");
        const before = row === undefined ? null : await one(tx, id);
        if (row === undefined || before === null) {
          return null;
        }
        if (row.revokedAt !== null) {
          throw conflict("This API client is revoked.", { reason: "revoked" });
        }
        const changes: ApiClientChange["changes"] = {};
        if (input.name !== undefined && input.name !== row.name) {
          await tx.update(apiTokens).set({ name: input.name }).where(eq(apiTokens.id, id));
          changes.name = { from: row.name, to: input.name };
        }
        if (input.grants !== undefined) {
          await requireChannels(tx, input.grants);
          await writeGrants(tx, id, input.grants, clock.now());
          changes.grants = { from: plainGrants(before.grants), to: [...input.grants] };
        }
        const client = await one(tx, id);
        if (client === null) {
          throw new Error("API client vanished during an update");
        }
        return { client, changes };
      });
    },

    async revoke(id) {
      if (!IdSchema.safeParse(id).success) {
        return null;
      }
      const [revoked] = await db
        .update(apiTokens)
        .set({ revokedAt: clock.now() })
        .where(and(eq(apiTokens.id, id), eq(apiTokens.kind, "api"), isNull(apiTokens.revokedAt)))
        .returning({ id: apiTokens.id });
      const client = await one(db, id);
      return client === null ? null : { client, revoked: revoked !== undefined };
    },

    async grants(tokenId, executor = db) {
      const rows = await executor
        .select({ channelId: apiTokenChannels.channelId, access: apiTokenChannels.access })
        .from(apiTokenChannels)
        .where(eq(apiTokenChannels.tokenId, tokenId));
      return new Map(rows.map((row) => [row.channelId, row.access]));
    },
  };
}
