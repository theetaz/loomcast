import {
  DAILY_TASK_INTERVAL_MS,
  type OAuthProvider,
  oauthProviderForPlatform,
  type Platform,
  TOKEN_REFRESH_LEAD_MS,
} from "@loomcast/contracts";
import { channels } from "@loomcast/db";
import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import type { ModuleDeps } from "../../deps";
import { audit } from "../../lib/audit";
import { afterCommit, type Executor, transaction } from "../../lib/db";
import type { Logger } from "../../lib/logger";
import {
  createThreadsGraphClient,
  type GraphClient,
  MetaGraphError,
  refreshThreadsToken,
} from "../../lib/meta-graph";
import { VaultError } from "../../lib/vault";
import { freshXAccessToken, usableXApp, type XClient, xClientFor } from "../publisher/adapters/x";
import { PublishFailure, publishError } from "../publisher/errors";
import { TaskFailure } from "../scheduler/scheduler";
import { readChannelSecret, sealChannelSecret } from "./credentials";
import { channelColumns, toChannel } from "./mappers";
import { flagNeedsReauth } from "./reauth";

// The daily credential sweeps. `channel.refresh_token` renews credentials that expire soon
// (Threads: within 15 days of their 60; X: within 10 minutes of their two hours, or already
// expired, which rotates the single-use refresh token so it never lapses; X only while
// `FEATURE_X_PUBLISHING` is on and its client is set, and never a call to X otherwise);
// `channel.verify` asks the platform whether each
// channel's credentials still work. A payload with `channelId` handles that channel alone; without
// one the task sweeps every connected channel and queues the next sweep a day later. A refused
// credential flags the channel `needs_reauth` with an alert; a transient failure is retried.

/** The task kinds of the sweeps. */
export const CHANNEL_SWEEP_KINDS = ["channel.refresh_token", "channel.verify"] as const;
export type ChannelSweepKind = (typeof CHANNEL_SWEEP_KINDS)[number];

/** Dedupe key of the queued daily sweep of `kind`. */
export function channelSweepDedupeKey(kind: ChannelSweepKind): string {
  return `sweep:${kind}`;
}

/**
 * Makes sure both daily sweeps are queued, without moving one that already is. Called when
 * channels are connected and when the server starts.
 */
export async function ensureChannelSweeps(
  scheduler: ModuleDeps["scheduler"],
  executor: Executor | null,
  now: Date,
): Promise<void> {
  for (const kind of CHANNEL_SWEEP_KINDS) {
    if (!scheduler.hasHandler(kind)) {
      continue;
    }
    const options = {
      runAt: new Date(now.getTime() + DAILY_TASK_INTERVAL_MS),
      dedupeKey: channelSweepDedupeKey(kind),
      onDuplicate: "keep" as const,
    };
    if (executor === null) {
      await scheduler.enqueue(kind, {}, options);
    } else {
      await scheduler.enqueue(executor, kind, {}, options);
    }
  }
}

/** A connected channel as the sweeps read it, without credentials. */
export interface SweepChannel {
  id: string;
  platform: Platform;
  externalId: string | null;
  status: string;
  displayName: string;
  tokenExpiresAt: Date | null;
}

/** Connected channels that are active (or `channelId` alone, whatever its status). */
export async function sweepChannels(
  db: ModuleDeps["db"],
  channelId: string | undefined,
): Promise<SweepChannel[]> {
  return db
    .select({
      id: channels.id,
      platform: channels.platform,
      externalId: channels.externalId,
      status: channels.status,
      displayName: channels.displayName,
      tokenExpiresAt: channels.tokenExpiresAt,
    })
    .from(channels)
    .where(
      and(
        isNotNull(channels.secretCiphertext),
        channelId === undefined ? eq(channels.status, "active") : eq(channels.id, channelId),
      ),
    )
    .orderBy(asc(channels.createdAt), asc(channels.id));
}

/** The outcome of one channel within a sweep. */
export type ChannelCheck = "ok" | "skipped" | "needs_reauth" | "failed";

/**
 * Runs `check` for each channel. A single-channel run turns a transient failure into a retryable
 * `TaskFailure`; a sweep logs it and moves on, so one channel cannot hold back the others.
 */
export async function runSweep(
  input: {
    kind: ChannelSweepKind;
    channelId: string | undefined;
    channels: SweepChannel[];
    logger: Logger;
    signal: AbortSignal;
    now: Date;
  },
  check: (channel: SweepChannel) => Promise<ChannelCheck>,
): Promise<{ next: Date } | undefined> {
  const counts: Record<ChannelCheck, number> = { ok: 0, skipped: 0, needs_reauth: 0, failed: 0 };
  for (const channel of input.channels) {
    if (input.signal.aborted) {
      throw new TaskFailure("aborted", "The sweep was interrupted.");
    }
    let outcome: ChannelCheck;
    try {
      outcome = await check(channel);
    } catch (error) {
      if (input.channelId !== undefined) {
        throw error;
      }
      input.logger.warn(
        {
          channelId: channel.id,
          platform: channel.platform,
          failure: error instanceof MetaGraphError ? error.toLog() : undefined,
          err: error instanceof MetaGraphError ? undefined : error,
        },
        `${input.kind} failed for one channel`,
      );
      outcome = "failed";
    }
    counts[outcome] += 1;
  }
  input.logger.info({ kind: input.kind, ...counts }, "channel sweep finished");
  return input.channelId === undefined
    ? { next: new Date(input.now.getTime() + DAILY_TASK_INTERVAL_MS) }
    : undefined;
}

/** A platform error as a task failure: retryable for throttling and transient errors. */
export function taskFailureOf(error: MetaGraphError): TaskFailure {
  return new TaskFailure(`platform_${error.error.code}`, error.error.message, {
    retryable: error.error.retryable,
    ...(error.error.retryAfterMs === undefined ? {} : { retryAfterMs: error.error.retryAfterMs }),
  });
}

/** Whether a platform error means the credentials themselves were refused. */
export function refusesCredentials(error: MetaGraphError): boolean {
  return error.error.code === "auth" || error.error.code === "permission";
}

/** The sign-in provider a channel's credentials come from. */
export function providerOf(platform: Platform): OAuthProvider {
  return oauthProviderForPlatform(platform);
}

/** Registers the refresh sweep. */
export function registerRefreshTask(deps: ModuleDeps): void {
  const { db, vault, scheduler, bus, config } = deps;
  const threadsClient: GraphClient = createThreadsGraphClient(config.platforms);
  let xClient: XClient | null = null;

  /** Publishes the channel as it now is, after a refresh outside a transaction of ours. */
  async function emitChannel(channelId: string): Promise<void> {
    const [row] = await db.select(channelColumns).from(channels).where(eq(channels.id, channelId));
    if (row !== undefined) {
      bus.publish({ type: "channel.updated", payload: { channel: toChannel(row, config) } });
    }
  }

  /**
   * Rotates an X channel's token pair through the X adapter's token store, which locks the row,
   * spends the single-use refresh token and stores the new pair in one transaction.
   */
  async function refreshX(
    channel: SweepChannel,
    logger: Logger,
    signal: AbortSignal,
    now: Date,
  ): Promise<ChannelCheck> {
    const app = usableXApp(config.platforms);
    if (app === null) {
      return "skipped";
    }
    xClient ??= xClientFor(config.platforms);
    try {
      const fresh = await freshXAccessToken(
        { db, vault },
        { client: xClient, app, channelId: channel.id, now, signal },
      );
      if (!fresh.refreshed) {
        return "skipped";
      }
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
      if (error instanceof PublishFailure) {
        if (error.error.code === "not_configured") {
          // Disconnected meanwhile.
          return "skipped";
        }
        await flagNeedsReauth(deps, logger, {
          channelId: channel.id,
          reason: "refresh_refused",
          error: error.error,
        });
        return "needs_reauth";
      }
      if (error instanceof MetaGraphError && refusesCredentials(error)) {
        await flagNeedsReauth(deps, logger, {
          channelId: channel.id,
          reason: "refresh_refused",
          error: error.error,
        });
        return "needs_reauth";
      }
      throw error instanceof MetaGraphError ? taskFailureOf(error) : error;
    }
    await emitChannel(channel.id);
    return "ok";
  }

  async function refreshOne(
    channel: SweepChannel,
    logger: Logger,
    signal: AbortSignal,
    now: Date,
  ): Promise<ChannelCheck> {
    const provider = providerOf(channel.platform);
    const lead = TOKEN_REFRESH_LEAD_MS[provider];
    // Meta Page credentials do not expire.
    if (provider === "meta" || lead === null || channel.tokenExpiresAt === null) {
      return "skipped";
    }
    if (channel.tokenExpiresAt.getTime() - now.getTime() > lead) {
      return "skipped";
    }
    // An X access token lives two hours, so it has usually expired by the sweep: the refresh
    // token renews it, and only a refused refresh needs the account reconnected.
    if (provider === "x") {
      return refreshX(channel, logger, signal, now);
    }
    if (channel.tokenExpiresAt.getTime() <= now.getTime()) {
      await flagNeedsReauth(deps, logger, {
        channelId: channel.id,
        reason: "token_expired",
        error: publishError("auth", "The credentials expired before they could be refreshed.", {
          retryable: false,
        }),
      });
      return "needs_reauth";
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
    let refreshed: Awaited<ReturnType<typeof refreshThreadsToken>>;
    try {
      refreshed = await refreshThreadsToken(threadsClient, {
        accessToken: secret.accessToken,
        signal,
      });
    } catch (error) {
      if (error instanceof MetaGraphError && refusesCredentials(error)) {
        await flagNeedsReauth(deps, logger, {
          channelId: channel.id,
          reason: "refresh_refused",
          error: error.error,
        });
        return "needs_reauth";
      }
      throw error instanceof MetaGraphError ? taskFailureOf(error) : error;
    }
    const tokenExpiresAt = new Date(now.getTime() + refreshed.expires_in * 1000);
    await transaction(db, async (tx) => {
      const sealed = sealChannelSecret(vault, channel.id, {
        ...secret,
        accessToken: refreshed.access_token,
      });
      const updated = await tx
        .update(channels)
        .set({
          ...sealed,
          tokenExpiresAt,
          lastError: null,
          updatedAt: sql`now()`,
        })
        .where(and(eq(channels.id, channel.id), isNotNull(channels.secretCiphertext)))
        .returning({ id: channels.id });
      if (updated.length === 0) {
        // Disconnected meanwhile: the new token is dropped with the old one.
        return;
      }
      await audit(tx, {
        actorKind: "system",
        action: "channel.token_refreshed",
        targetType: "channel",
        targetId: channel.id,
        data: { platform: channel.platform, tokenExpiresAt: tokenExpiresAt.toISOString() },
      });
      const [row] = await tx
        .select(channelColumns)
        .from(channels)
        .where(eq(channels.id, channel.id));
      if (row !== undefined) {
        const view = toChannel(row, config);
        afterCommit(tx, () => bus.publish({ type: "channel.updated", payload: { channel: view } }));
      }
    });
    return "ok";
  }

  scheduler.register("channel.refresh_token", async ({ payload, logger, signal, now }) => {
    const at = now();
    const list = await sweepChannels(db, payload.channelId);
    return runSweep(
      {
        kind: "channel.refresh_token",
        channelId: payload.channelId,
        channels: list,
        logger,
        signal,
        now: at,
      },
      (channel) => refreshOne(channel, logger, signal, at),
    );
  });
}
