import { type Channel, channelPicturePath } from "@loomcast/contracts";
import { type ChannelRow, channels } from "@loomcast/db";
import { asc, eq, sql } from "drizzle-orm";
import type { Executor } from "../../lib/db";
import { pictureVersion } from "../../lib/pictures";
import { type LiveGateSettings, livePublishingBlocker } from "../publisher/gates";

/**
 * The columns a channel response is built from. The sealed credentials are never selected: only
 * whether there are any (`connected`). `picture` is the platform's picture address, which the
 * response replaces with the API path that passes it through.
 */
export const channelColumns = {
  id: channels.id,
  workspaceId: channels.workspaceId,
  platform: channels.platform,
  displayName: channels.displayName,
  externalId: channels.externalId,
  username: channels.username,
  parentChannelId: channels.parentChannelId,
  status: channels.status,
  dryRun: channels.dryRun,
  requiresApproval: channels.requiresApproval,
  scopes: channels.scopes,
  tokenExpiresAt: channels.tokenExpiresAt,
  createdAt: channels.createdAt,
  updatedAt: channels.updatedAt,
  disabledAt: channels.disabledAt,
  lastVerifiedAt: channels.lastVerifiedAt,
  lastError: channels.lastError,
  rateLimit: channels.rateLimit,
  connected: sql<boolean>`${channels.secretCiphertext} is not null`,
  picture: sql<string | null>`${channels.meta}->>'picture'`,
};

export type ChannelView = Omit<
  ChannelRow,
  "secretCiphertext" | "secretNonce" | "keyVersion" | "meta" | "createdBy"
> & { connected: boolean; picture: string | null };

/**
 * The channels as the API shows them, by platform, name and age: the workspace's, or every
 * workspace's when `workspaceId` is null.
 */
export async function listChannels(
  executor: Executor,
  settings: LiveGateSettings,
  workspaceId: string | null,
): Promise<Channel[]> {
  const rows = await executor
    .select(channelColumns)
    .from(channels)
    .where(workspaceId === null ? undefined : eq(channels.workspaceId, workspaceId))
    .orderBy(asc(channels.platform), asc(channels.displayName), asc(channels.createdAt));
  return rows.map((row) => toChannel(row, settings));
}

/**
 * A channel as the API shows it, with the reason it cannot go live under the server's `settings`
 * (publishing mode and platform switches such as `FEATURE_X_PUBLISHING`), if any.
 */
export function toChannel(row: ChannelView, settings: LiveGateSettings): Channel {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    platform: row.platform,
    displayName: row.displayName,
    externalId: row.externalId,
    username: row.username,
    parentChannelId: row.parentChannelId,
    pictureUrl:
      row.picture === null ? null : channelPicturePath(row.id, pictureVersion(row.picture)),
    status: row.status,
    dryRun: row.dryRun,
    requiresApproval: row.requiresApproval,
    connected: row.connected,
    scopes: row.scopes,
    tokenExpiresAt: row.tokenExpiresAt?.toISOString() ?? null,
    liveBlocker: livePublishingBlocker(row, settings),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    disabledAt: row.disabledAt?.toISOString() ?? null,
    lastVerifiedAt: row.lastVerifiedAt?.toISOString() ?? null,
    lastError: row.lastError ?? null,
  };
}
