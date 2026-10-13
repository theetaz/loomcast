import type {
  ChannelStatus,
  LivePublishingBlocker,
  Platform,
  PublishingMode,
} from "@loomcast/contracts";
import { publishAttempts, scheduledPosts } from "@loomcast/db";
import { and, asc, eq, gt, isNull } from "drizzle-orm";
import type { Executor } from "../../lib/db";
import { isLivePlatformAvailable } from "./adapters";
import type { XPlatforms } from "./adapters/x";

// The gates a post passes before anything is sent. The dry-run gate decides whether a post may go
// live at all; the rate gate keeps live posting under each platform's daily publishing limit.

/** The server settings the live gate reads: the publishing mode and the platform switches. */
export interface LiveGateSettings {
  publishing: { mode: PublishingMode };
  platforms: XPlatforms;
}

/**
 * Why a channel cannot publish live, or null when it can: the platform must have a live adapter
 * (X only while its feature flag is on), the channel must be connected and active, and the server
 * must publish live.
 */
export function livePublishingBlocker(
  channel: { platform: Platform; status: ChannelStatus; connected: boolean },
  settings: LiveGateSettings,
): LivePublishingBlocker | null {
  if (!isLivePlatformAvailable(channel.platform, settings.platforms)) {
    return "platform_unavailable";
  }
  if (!channel.connected) {
    return "not_connected";
  }
  if (channel.status !== "active") {
    return "not_active";
  }
  if (settings.publishing.mode !== "live") {
    return "publishing_dry_run";
  }
  return null;
}

/**
 * Whether a post publishes in dry-run: when the post was created in dry-run, when its channel is
 * in dry-run now, or when the server is. Any one of them is enough, so switching a channel back
 * to dry-run also holds back posts queued while it was live.
 */
export function isDryRun(
  post: { dryRun: boolean },
  channel: { dryRun: boolean },
  mode: PublishingMode,
): boolean {
  return post.dryRun || channel.dryRun || mode !== "live";
}

/** The rolling window of the platforms' publishing limits. */
export const RATE_WINDOW_MS = 24 * 60 * 60_000;

/**
 * Live posts per channel in any 24 hours. The platforms document 100 (Instagram, whose own guide
 * also says 50: the lower figure applies), 30 (Facebook Page Reels), 250 (Threads) and 17 (X on
 * the free tier). The live adapters also ask the platform's quota endpoint before posting.
 */
export const PLATFORM_DAILY_POST_LIMITS: { readonly [P in Platform]: number } = {
  instagram: 50,
  facebook: 30,
  threads: 250,
  x: 17,
};

/** Shortest wait the rate gate asks for. */
const MIN_RATE_WAIT_MS = 60_000;

export type RateGateDecision =
  | { allowed: true }
  | { allowed: false; retryAfterMs: number; limit: number };

/**
 * The rate gate: counts the channel's live attempts that did not fail in the last 24 hours. At
 * the limit, the post waits until the oldest of them leaves the window.
 */
export async function checkRateGate(
  executor: Executor,
  input: { channelId: string; platform: Platform; now: Date; limit?: number },
): Promise<RateGateDecision> {
  const limit = input.limit ?? PLATFORM_DAILY_POST_LIMITS[input.platform];
  const since = new Date(input.now.getTime() - RATE_WINDOW_MS);
  const rows = await executor
    .select({ startedAt: publishAttempts.startedAt })
    .from(publishAttempts)
    .innerJoin(scheduledPosts, eq(scheduledPosts.id, publishAttempts.postId))
    .where(
      and(
        eq(scheduledPosts.channelId, input.channelId),
        eq(publishAttempts.dryRun, false),
        isNull(publishAttempts.error),
        gt(publishAttempts.startedAt, since),
      ),
    )
    .orderBy(asc(publishAttempts.startedAt));
  if (rows.length < limit) {
    return { allowed: true };
  }
  const oldest = rows[rows.length - limit]?.startedAt ?? input.now;
  const retryAfterMs = Math.max(
    MIN_RATE_WAIT_MS,
    oldest.getTime() + RATE_WINDOW_MS - input.now.getTime(),
  );
  return { allowed: false, retryAfterMs, limit };
}
