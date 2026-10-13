import { channels, purgeExpiredOAuth } from "@loomcast/db";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import type { ModuleDeps } from "../../deps";
import { afterCommit, transaction } from "../../lib/db";
import type { Logger } from "../../lib/logger";
import {
  classifyMetaError,
  createMetaGraphClient,
  createThreadsGraphClient,
  debugMetaToken,
  getMetaPicture,
  getThreadsProfile,
  MetaGraphError,
} from "../../lib/meta-graph";
import { pictureUrlOf } from "../../lib/pictures";
import { VaultError } from "../../lib/vault";
import { publishError } from "../publisher/errors";
import { readChannelSecret } from "./credentials";
import { channelColumns, toChannel } from "./mappers";
import { flagNeedsReauth } from "./reauth";
import {
  type ChannelCheck,
  providerOf,
  refusesCredentials,
  runSweep,
  type SweepChannel,
  sweepChannels,
  taskFailureOf,
} from "./tasks";

// `channel.verify`: once a day, ask the platform whether each connected channel's credentials
// still work. Meta credentials go through `debug_token` with the app access token; Threads
// credentials read their own profile. A refused credential flags the channel `needs_reauth`
// (with an event and an alert); a working one records `lastVerifiedAt` and clears the last error.
// A working check also stores the account's current profile picture address, because the
// platforms' picture addresses expire. The daily sweep also deletes expired sign-in states and
// pending connections.

/** Registers the verify sweep. */
export function registerVerifyTask(deps: ModuleDeps): void {
  const { db, vault, scheduler, bus, config } = deps;
  const metaClient = createMetaGraphClient(config.platforms);
  const threadsClient = createThreadsGraphClient(config.platforms);

  /**
   * Records a successful check; a channel waiting for reauth turns active again. `picture` is the
   * account's current picture address, when the check could read one.
   */
  async function markVerified(
    channel: SweepChannel,
    now: Date,
    scopes: string[] | undefined,
    picture: string | undefined,
  ): Promise<void> {
    await transaction(db, async (tx) => {
      const [current] = await tx
        .select({
          status: channels.status,
          lastError: channels.lastError,
          picture: channelColumns.picture,
        })
        .from(channels)
        .where(and(eq(channels.id, channel.id), isNotNull(channels.secretCiphertext)))
        .for("update");
      if (current === undefined) {
        return;
      }
      const reactivate = current.status === "needs_reauth";
      const newPicture = picture !== undefined && picture !== current.picture;
      await tx
        .update(channels)
        .set({
          lastVerifiedAt: now,
          lastError: null,
          ...(reactivate ? { status: "active" as const } : {}),
          ...(scopes !== undefined && scopes.length > 0 ? { scopes } : {}),
          ...(newPicture
            ? { meta: sql`${channels.meta} || ${JSON.stringify({ picture })}::jsonb` }
            : {}),
          updatedAt: sql`now()`,
        })
        .where(eq(channels.id, channel.id));
      if (reactivate || current.lastError !== null || newPicture) {
        const [row] = await tx
          .select(channelColumns)
          .from(channels)
          .where(eq(channels.id, channel.id));
        if (row !== undefined) {
          const view = toChannel(row, config);
          afterCommit(tx, () =>
            bus.publish({ type: "channel.updated", payload: { channel: view } }),
          );
        }
      }
    });
  }

  /**
   * The current picture address of a Page or Instagram account, or undefined when it cannot be
   * read: a missing picture never fails the check.
   */
  async function metaPicture(
    channel: SweepChannel,
    secret: { accessToken: string },
    signal: AbortSignal,
  ): Promise<string | undefined> {
    if (
      channel.externalId === null ||
      (channel.platform !== "facebook" && channel.platform !== "instagram")
    ) {
      return undefined;
    }
    try {
      return pictureUrlOf(
        await getMetaPicture(metaClient, {
          platform: channel.platform,
          accountId: channel.externalId,
          accessToken: secret.accessToken,
          signal,
        }),
      );
    } catch (error) {
      if (error instanceof MetaGraphError) {
        return undefined;
      }
      throw error;
    }
  }

  async function verifyOne(
    channel: SweepChannel,
    logger: Logger,
    signal: AbortSignal,
    now: Date,
  ): Promise<ChannelCheck> {
    const provider = providerOf(channel.platform);
    if (provider === "x") {
      return "skipped";
    }
    const meta = config.platforms.meta;
    if (provider === "meta" && meta === null) {
      return "skipped";
    }
    let secret: Awaited<ReturnType<typeof readChannelSecret>>;
    try {
      secret = await readChannelSecret(db, vault, channel.id);
    } catch (error) {
      if (error instanceof VaultError) {
        await flagNeedsReauth(deps, logger, {
          channelId: channel.id,
          reason: "unreadable_credentials",
          error: publishError("auth", "The stored credentials cannot be read; reconnect.", {
            retryable: false,
          }),
        });
        return "needs_reauth";
      }
      throw error;
    }
    if (secret === null) {
      return "skipped";
    }

    try {
      if (provider === "meta" && meta !== null) {
        // Errors of the call itself (the app token) throw; the verdict on the channel's token is
        // in `is_valid` and `error`.
        const debug = await debugMetaToken(metaClient, meta, {
          inputToken: secret.accessToken,
          signal,
        });
        if (!debug.is_valid) {
          const classified = classifyMetaError(
            { status: 200, code: debug.error?.code ?? 190, subcode: debug.error?.subcode },
            debug.error?.message ?? "The platform reports the credentials as invalid.",
          );
          const error =
            classified.code === "auth" || classified.code === "permission"
              ? classified
              : { ...classified, code: "auth" as const, retryable: false };
          await flagNeedsReauth(deps, logger, {
            channelId: channel.id,
            reason: "token_invalid",
            error,
          });
          return "needs_reauth";
        }
        await markVerified(channel, now, debug.scopes, await metaPicture(channel, secret, signal));
        return "ok";
      }

      if (channel.tokenExpiresAt !== null && channel.tokenExpiresAt.getTime() <= now.getTime()) {
        await flagNeedsReauth(deps, logger, {
          channelId: channel.id,
          reason: "token_expired",
          error: publishError("auth", "The credentials expired.", { retryable: false }),
        });
        return "needs_reauth";
      }
      const profile = await getThreadsProfile(threadsClient, {
        accessToken: secret.accessToken,
        signal,
      });
      await markVerified(
        channel,
        now,
        undefined,
        pictureUrlOf(profile.threads_profile_picture_url),
      );
      return "ok";
    } catch (error) {
      if (error instanceof MetaGraphError) {
        if (provider === "threads" && refusesCredentials(error)) {
          await flagNeedsReauth(deps, logger, {
            channelId: channel.id,
            reason: "token_refused",
            error: error.error,
          });
          return "needs_reauth";
        }
        throw taskFailureOf(error);
      }
      throw error;
    }
  }

  scheduler.register("channel.verify", async ({ payload, logger, signal, now }) => {
    const at = now();
    if (payload.channelId === undefined) {
      const purged = await purgeExpiredOAuth(db, { now: at });
      logger.info(purged, "expired sign-ins purged");
    }
    const list = await sweepChannels(db, payload.channelId);
    return runSweep(
      {
        kind: "channel.verify",
        channelId: payload.channelId,
        channels: list,
        logger,
        signal,
        now: at,
      },
      (channel) => verifyOne(channel, logger, signal, at),
    );
  });
}
