import type { Channel, PublishingMode } from "@loomcast/contracts";
import { type ChannelRow, channels } from "@loomcast/db";
import { sql } from "drizzle-orm";
import { livePublishingBlocker } from "../publisher/gates";

/**
 * The columns a channel response is built from. The sealed credentials are never selected: only
 * whether there are any (`connected`).
 */
export const channelColumns = {
  id: channels.id,
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
  connected: sql<boolean>`${channels.secretCiphertext} is not null`,
};

export type ChannelView = Omit<
  ChannelRow,
  "secretCiphertext" | "secretNonce" | "keyVersion" | "meta" | "createdBy"
> & { connected: boolean };

/** A channel as the API shows it, with the reason it cannot go live under `mode`, if any. */
export function toChannel(row: ChannelView, mode: PublishingMode): Channel {
  return {
    id: row.id,
    platform: row.platform,
    displayName: row.displayName,
    externalId: row.externalId,
    username: row.username,
    parentChannelId: row.parentChannelId,
    status: row.status,
    dryRun: row.dryRun,
    requiresApproval: row.requiresApproval,
    connected: row.connected,
    scopes: row.scopes,
    tokenExpiresAt: row.tokenExpiresAt?.toISOString() ?? null,
    liveBlocker: livePublishingBlocker(row, mode),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    disabledAt: row.disabledAt?.toISOString() ?? null,
  };
}
