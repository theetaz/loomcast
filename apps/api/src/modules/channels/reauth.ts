import type { PublishError } from "@loomcast/contracts";
import { channels } from "@loomcast/db";
import { eq, sql } from "drizzle-orm";
import type { ModuleDeps } from "../../deps";
import { audit } from "../../lib/audit";
import { afterCommit, transaction } from "../../lib/db";
import type { Logger } from "../../lib/logger";
import type { SchedulerAlert } from "../scheduler/scheduler";
import { channelColumns, toChannel } from "./mappers";

export type ReauthDeps = Pick<ModuleDeps, "db" | "bus" | "config" | "alert">;

/** Sends `alert` to the alert hook, or logs it at error level without one. Never throws. */
export async function raiseChannelAlert(
  deps: Pick<ModuleDeps, "alert">,
  logger: Logger,
  alert: SchedulerAlert,
): Promise<void> {
  try {
    if (deps.alert === undefined) {
      logger.error({ alert: alert.key, ...alert.data }, alert.title);
    } else {
      await deps.alert(alert);
    }
  } catch (error) {
    logger.error({ err: error, alert: alert.key }, "could not send a channel alert");
  }
}

/**
 * Records that the platform refused a channel's credentials: the channel turns `needs_reauth`
 * (a disabled one stays disabled) with `error` as its last error, which is audited, published as
 * `channel.updated` and raised as an alert once committed. Its credentials stay until someone
 * reconnects or disconnects it. Returns false when the channel no longer has credentials.
 */
export async function flagNeedsReauth(
  deps: ReauthDeps,
  logger: Logger,
  input: { channelId: string; error: PublishError; reason: string },
): Promise<boolean> {
  const flagged = await transaction(deps.db, async (tx) => {
    const [current] = await tx
      .select({
        id: channels.id,
        status: channels.status,
        platform: channels.platform,
        displayName: channels.displayName,
        connected: channelColumns.connected,
      })
      .from(channels)
      .where(eq(channels.id, input.channelId))
      .for("update");
    if (current === undefined || !current.connected) {
      return null;
    }
    await tx
      .update(channels)
      .set({
        status: current.status === "disabled" ? "disabled" : "needs_reauth",
        lastError: input.error,
        updatedAt: sql`now()`,
      })
      .where(eq(channels.id, input.channelId));
    const [row] = await tx
      .select(channelColumns)
      .from(channels)
      .where(eq(channels.id, input.channelId));
    if (row === undefined) {
      return null;
    }
    await audit(tx, {
      actorKind: "system",
      action: "channel.needs_reauth",
      targetType: "channel",
      targetId: input.channelId,
      data: {
        platform: current.platform,
        reason: input.reason,
        code: input.error.code,
        ...(input.error.platformCode === undefined
          ? {}
          : { platformCode: input.error.platformCode }),
      },
    });
    const channel = toChannel(row, deps.config.publishing.mode);
    afterCommit(tx, () => deps.bus.publish({ type: "channel.updated", payload: { channel } }));
    return current;
  });
  if (flagged === null) {
    return false;
  }
  await raiseChannelAlert(deps, logger, {
    key: `channel.needs_reauth:${input.channelId}`,
    title: "A channel needs reconnecting",
    message:
      `The ${flagged.platform} channel "${flagged.displayName}" was refused by the platform ` +
      `(${input.error.message}). Reconnect it in Settings, Channels.`,
    data: {
      channelId: input.channelId,
      platform: flagged.platform,
      code: input.error.code,
      reason: input.reason,
    },
  });
  return true;
}
