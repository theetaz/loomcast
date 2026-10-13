import {
  type Channel,
  type LivePublishingBlocker,
  oauthProviderForPlatform,
  type Platform,
  TOKEN_REFRESH_LEAD_MS,
} from "@loomcast/contracts";
import { platformLabel } from "./platforms";

// What the channel switches may do, as the server decides it. The server sends `liveBlocker` with
// every channel; these helpers only turn it into words and states, so the screens never guess.

const DAY_MS = 24 * 60 * 60_000;

/** Why a channel can't leave dry-run, in a sentence. */
export function liveBlockerReason(blocker: LivePublishingBlocker, platform: Platform): string {
  switch (blocker) {
    case "not_connected":
      return "Connect this channel's account first. A planning channel only records what it would send.";
    case "not_active":
      return "Reconnect or enable this channel first.";
    case "publishing_dry_run":
      return "The server is in dry-run mode, so every channel only records what it would send.";
    case "platform_unavailable":
      return `Publishing live to ${platformLabel(platform)} isn't available yet.`;
    default:
      return "This channel can't publish live yet.";
  }
}

/** The dry-run switch: on while the channel dry-runs; switching it off needs no blocker. */
export interface DryRunSwitchState {
  checked: boolean;
  disabled: boolean;
  /** Why the switch is off limits, when it is. */
  reason: string | null;
}

export function dryRunSwitchState(
  channel: Pick<Channel, "dryRun" | "liveBlocker" | "platform">,
): DryRunSwitchState {
  // Turning dry-run back on is always allowed; leaving it needs the server's go-ahead.
  if (channel.dryRun && channel.liveBlocker !== null) {
    return {
      checked: true,
      disabled: true,
      reason: liveBlockerReason(channel.liveBlocker, channel.platform),
    };
  }
  return { checked: channel.dryRun, disabled: false, reason: null };
}

/** Whether a channel is locked to dry-run by its platform, such as X until its adapter ships. */
export function isPlatformLocked(channel: Pick<Channel, "liveBlocker">): boolean {
  return channel.liveBlocker === "platform_unavailable";
}

export type ExpiryWarning = { tone: "red" | "amber"; message: string } | null;

function inDays(ms: number): string {
  const days = Math.round(ms / DAY_MS);
  if (days >= 2) return `in ${days} days`;
  const hours = Math.max(1, Math.round(ms / (60 * 60_000)));
  return hours >= 24 ? "in a day" : `in ${hours} ${hours === 1 ? "hour" : "hours"}`;
}

/**
 * A warning about the channel's stored access running out. Providers whose credentials the
 * scheduler refreshes warn once half the refresh window has passed without a refresh; the others
 * warn a week ahead. Expired access is always red.
 */
export function tokenExpiryWarning(
  channel: Pick<Channel, "platform" | "tokenExpiresAt" | "connected">,
  now: number = Date.now(),
): ExpiryWarning {
  if (!channel.connected || channel.tokenExpiresAt === null) return null;
  const left = Date.parse(channel.tokenExpiresAt) - now;
  if (Number.isNaN(left)) return null;
  if (left <= 0) {
    return { tone: "red", message: "Access expired. Reconnect the account to publish." };
  }
  const lead = TOKEN_REFRESH_LEAD_MS[oauthProviderForPlatform(channel.platform)];
  const warnWithin = lead === null ? 7 * DAY_MS : lead / 2;
  if (left > warnWithin) return null;
  return {
    tone: "amber",
    message: `Access expires ${inDays(left)}. Reconnect the account if it isn't renewed.`,
  };
}
