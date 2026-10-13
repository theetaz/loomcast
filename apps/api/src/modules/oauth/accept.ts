import { randomUUID } from "node:crypto";
import type { Channel, OAuthProvider, Platform } from "@loomcast/contracts";
import { channels, consumeOAuthConnection, type OAuthCandidateRow } from "@loomcast/db";
import { and, eq, sql } from "drizzle-orm";
import type { ModuleDeps } from "../../deps";
import { audit } from "../../lib/audit";
import { afterCommit, type Transaction } from "../../lib/db";
import { HttpError } from "../../lib/errors";
import { oauthConnectionAad, sealedSecretOf, type TokenVault } from "../../lib/vault";
import { type StoredChannelSecret, sealChannelSecret } from "../channels/credentials";
import { channelColumns, toChannel } from "../channels/mappers";
import { ensureChannelSweeps } from "../channels/tasks";
import { type CandidateSecret, ConnectionSecretSchema } from "./types";

export const connectionExpired = () =>
  new HttpError(410, "connection_expired", "This sign-in has expired or was already used.");

/**
 * The chosen accounts and their parents, parents first: accepting an Instagram account connects
 * the Page it publishes through, because the Page holds the token.
 */
export function withParents(
  candidates: readonly OAuthCandidateRow[],
  chosen: readonly string[],
): OAuthCandidateRow[] {
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const selected = new Set<string>();
  for (const id of chosen) {
    let current = byId.get(id);
    // Parents are one level deep in practice; the bound guards against a malformed cycle.
    for (let depth = 0; current !== undefined && depth < 4; depth += 1) {
      selected.add(current.id);
      current = current.parentId === null ? undefined : byId.get(current.parentId);
    }
  }
  const depthOf = (candidate: OAuthCandidateRow): number => {
    let depth = 0;
    let current = candidate;
    while (current.parentId !== null && depth < 4) {
      const parent = byId.get(current.parentId);
      if (parent === undefined) {
        break;
      }
      current = parent;
      depth += 1;
    }
    return depth;
  };
  return candidates
    .filter((candidate) => selected.has(candidate.id))
    .sort((a, b) => depthOf(a) - depthOf(b));
}

export interface AcceptInput {
  connectionId: string;
  userId: string;
  provider: OAuthProvider;
  /** The accounts to connect, parents included and first (`withParents`). */
  accounts: readonly OAuthCandidateRow[];
  ip: string;
  now: Date;
}

/**
 * Consumes the pending connection and creates or reconnects one channel per account, in `tx`. A
 * channel of the same platform and account id is reconnected: its credentials are replaced, it
 * turns `active` (unless disabled), its last error is cleared and its profile picture replaced,
 * while its name and dry-run switch stay as the user left them. New channels are `active` with
 * dry-run on. Throws `connection_expired` when the connection was used or expired meanwhile.
 */
export async function acceptConnection(
  tx: Transaction,
  deps: Pick<ModuleDeps, "vault" | "bus" | "config" | "scheduler">,
  input: AcceptInput,
): Promise<Channel[]> {
  const consumed = await consumeOAuthConnection(tx, {
    id: input.connectionId,
    userId: input.userId,
    now: input.now,
  });
  const sealed = consumed === null ? null : sealedSecretOf(consumed);
  if (consumed === null || sealed === null) {
    throw connectionExpired();
  }
  const secret = ConnectionSecretSchema.parse(
    deps.vault.decrypt(sealed, oauthConnectionAad(input.connectionId)),
  );

  const channelIds = new Map<string, string>();
  const result: Channel[] = [];
  for (const account of input.accounts) {
    const credentials = secret.accounts[account.id];
    if (credentials === undefined) {
      throw new Error("a pending connection has no credentials for one of its accounts");
    }
    const parentChannelId =
      account.parentId === null ? null : (channelIds.get(account.parentId) ?? null);
    const id = await upsertChannel(tx, deps.vault, {
      account,
      credentials,
      provider: input.provider,
      parentChannelId,
      userId: input.userId,
      ip: input.ip,
      now: input.now,
    });
    channelIds.set(account.id, id);
    const [row] = await tx.select(channelColumns).from(channels).where(eq(channels.id, id));
    if (row === undefined) {
      throw new Error("the channel vanished");
    }
    const channel = toChannel(row, deps.config);
    afterCommit(tx, () => deps.bus.publish({ type: "channel.updated", payload: { channel } }));
    result.push(channel);
  }
  // Connected channels are checked and refreshed by the daily sweeps.
  await ensureChannelSweeps(deps.scheduler, tx, input.now);
  return result;
}

async function upsertChannel(
  tx: Transaction,
  vault: TokenVault,
  input: {
    account: OAuthCandidateRow;
    credentials: CandidateSecret;
    provider: OAuthProvider;
    parentChannelId: string | null;
    userId: string;
    ip: string;
    now: Date;
  },
): Promise<string> {
  const { account, credentials } = input;
  const platform: Platform = account.platform;
  const [existing] = await tx
    .select({ id: channels.id, status: channels.status })
    .from(channels)
    .where(and(eq(channels.platform, platform), eq(channels.externalId, account.externalId)))
    .for("update");
  const id = existing?.id ?? randomUUID();
  const stored: StoredChannelSecret = {
    ...credentials.extra,
    accessToken: credentials.accessToken,
    provider: input.provider,
  };
  const sealed = sealChannelSecret(vault, id, stored);
  const tokenExpiresAt =
    credentials.tokenExpiresAt === null ? null : new Date(credentials.tokenExpiresAt);
  const values = {
    // The picture is replaced, or dropped when the platform no longer gives one.
    meta:
      account.picture === undefined
        ? sql`${channels.meta} - 'picture'`
        : sql`${channels.meta} || ${JSON.stringify({ picture: account.picture })}::jsonb`,
    username: account.username ?? null,
    parentChannelId: input.parentChannelId,
    secretCiphertext: sealed.secretCiphertext,
    secretNonce: sealed.secretNonce,
    keyVersion: sealed.keyVersion,
    scopes: credentials.scopes,
    tokenExpiresAt,
    lastVerifiedAt: input.now,
    lastError: null,
  };
  if (existing === undefined) {
    await tx.insert(channels).values({
      id,
      platform,
      displayName: account.name,
      externalId: account.externalId,
      status: "active",
      dryRun: true,
      createdBy: input.userId,
      ...values,
      meta: account.picture === undefined ? {} : { picture: account.picture },
    });
  } else {
    await tx
      .update(channels)
      .set({
        ...values,
        status: existing.status === "disabled" ? "disabled" : "active",
        updatedAt: sql`now()`,
      })
      .where(eq(channels.id, id));
  }
  await audit(tx, {
    actorKind: "user",
    actorId: input.userId,
    action: existing === undefined ? "channel.connected" : "channel.reconnected",
    targetType: "channel",
    targetId: id,
    data: {
      platform,
      externalId: account.externalId,
      provider: input.provider,
      parentChannelId: input.parentChannelId,
      scopes: credentials.scopes,
    },
    ip: input.ip,
  });
  return id;
}
