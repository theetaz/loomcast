import { CHANNEL_STATUSES, LIVE_PUBLISHING_BLOCKERS, POST_STATUSES } from "@loomcast/contracts";
import { STATUS_STYLES } from "@loomcast/ui/components/StatusPill";
import { describe, expect, it } from "vitest";
import { connectProviders } from "@/features/channels/connect/providers";
import { orderCandidates, toggleCandidate } from "@/features/channels/connect/selection";
import { sortChannels } from "@/features/channels/platforms";
import { withLink } from "@/features/channels/queries";
import {
  confirmsGoLive,
  dryRunSwitchState,
  goLivePreconditions,
  liveBlockerReason,
  tokenExpiryWarning,
} from "@/features/channels/rules";
import { seriesChannelLock } from "@/features/channels/SeriesChannelsCard";
import { mockChannel, mockLiveBlocker } from "@/mocks/calendar";

const NOW = Date.parse("2026-10-14T08:00:00.000Z");
const DAY_MS = 24 * 60 * 60_000;
const inDays = (days: number) => new Date(NOW + days * DAY_MS).toISOString();

describe("status pill kinds", () => {
  it("covers every post and channel status of the contracts", () => {
    expect(Object.keys(STATUS_STYLES.post).sort()).toEqual([...POST_STATUSES].sort());
    expect(Object.keys(STATUS_STYLES.channel).sort()).toEqual([...CHANNEL_STATUSES].sort());
  });
});

describe("dry-run switch", () => {
  it("stays on and says why while the server names a blocker", () => {
    const state = dryRunSwitchState({
      dryRun: true,
      liveBlocker: "publishing_dry_run",
      platform: "facebook",
    });
    expect(state).toEqual({
      checked: true,
      disabled: true,
      reason: "The server is in dry-run mode, so every channel only records what it would send.",
    });
  });

  it("can be switched off when nothing blocks it", () => {
    expect(dryRunSwitchState({ dryRun: true, liveBlocker: null, platform: "instagram" })).toEqual({
      checked: true,
      disabled: false,
      reason: null,
    });
  });

  it("can always go back to dry-run, even once the server blocks going live", () => {
    expect(
      dryRunSwitchState({ dryRun: false, liveBlocker: "not_active", platform: "threads" }),
    ).toEqual({ checked: false, disabled: false, reason: null });
  });

  it("explains every blocker, naming the platform when it is the platform", () => {
    for (const blocker of LIVE_PUBLISHING_BLOCKERS) {
      expect(liveBlockerReason(blocker, "x").length).toBeGreaterThan(10);
    }
    expect(liveBlockerReason("platform_unavailable", "x")).toBe(
      "Publishing live to X isn't available yet.",
    );
    expect(liveBlockerReason("not_connected", "instagram")).toMatch(/^Connect this channel/);
  });

  it("follows the server's rule in the mock: platform, connection, status, then mode", () => {
    const base = { platform: "instagram" as const, status: "active" as const, connected: true };
    expect(mockLiveBlocker({ ...base, platform: "x" }, "live")).toBe("platform_unavailable");
    expect(mockLiveBlocker({ ...base, connected: false }, "live")).toBe("not_connected");
    expect(mockLiveBlocker({ ...base, status: "needs_reauth" }, "live")).toBe("not_active");
    expect(mockLiveBlocker(base, "dry-run")).toBe("publishing_dry_run");
    expect(mockLiveBlocker(base, "live")).toBeNull();
  });
});

describe("token expiry warning", () => {
  const connected = (platform: "facebook" | "threads", tokenExpiresAt: string | null) => ({
    platform,
    tokenExpiresAt,
    connected: true,
  });

  it("says nothing for planning channels and access that does not expire", () => {
    expect(
      tokenExpiryWarning({ platform: "threads", tokenExpiresAt: inDays(1), connected: false }, NOW),
    ).toBeNull();
    expect(tokenExpiryWarning(connected("facebook", null), NOW)).toBeNull();
  });

  it("warns once a refreshed credential is past half its refresh window", () => {
    // Threads credentials are refreshed from 15 days before expiry.
    expect(tokenExpiryWarning(connected("threads", inDays(10)), NOW)).toBeNull();
    expect(tokenExpiryWarning(connected("threads", inDays(4)), NOW)).toEqual({
      tone: "amber",
      message: "Access expires in 4 days. Reconnect the account if it isn't renewed.",
    });
  });

  it("warns a week ahead for credentials that are never refreshed, and in red once expired", () => {
    expect(tokenExpiryWarning(connected("facebook", inDays(10)), NOW)).toBeNull();
    expect(tokenExpiryWarning(connected("facebook", inDays(0.25)), NOW)?.message).toBe(
      "Access expires in 6 hours. Reconnect the account if it isn't renewed.",
    );
    expect(tokenExpiryWarning(connected("facebook", inDays(-1)), NOW)).toEqual({
      tone: "red",
      message: "Access expired. Reconnect the account to publish.",
    });
  });
});

describe("series channel links", () => {
  it("replaces a link in place or adds it at the end", () => {
    const links = [
      { channelId: "a", enabled: true },
      { channelId: "b", enabled: true },
    ];
    expect(withLink(links, { channelId: "a", enabled: false })).toEqual([
      { channelId: "a", enabled: false },
      { channelId: "b", enabled: true },
    ]);
    expect(
      withLink(links, { channelId: "c", enabled: true }).map((link) => link.channelId),
    ).toEqual(["a", "b", "c"]);
  });

  it("locks every switch of an archived series and switching a disabled channel on", () => {
    expect(seriesChannelLock({ status: "archived" }, { status: "active" }, true)).toMatch(
      /archived/,
    );
    expect(seriesChannelLock({ status: "active" }, { status: "disabled" }, false)).toBe(
      "The channel is disabled.",
    );
    // Linked and enabled: it can still be switched off.
    expect(seriesChannelLock({ status: "active" }, { status: "disabled" }, true)).toBeNull();
    expect(seriesChannelLock({ status: "paused" }, { status: "active" }, false)).toBeNull();
  });

  it("orders channels by platform, then name", () => {
    const at = "2026-10-01T08:00:00.000Z";
    const channels = [
      mockChannel({ platform: "x", displayName: "a", createdAt: at }),
      mockChannel({ platform: "threads", displayName: "b", createdAt: at }),
      mockChannel({ platform: "facebook", displayName: "z", createdAt: at }),
      mockChannel({ platform: "facebook", displayName: "m", createdAt: at }),
    ];
    expect(sortChannels(channels).map((channel) => channel.displayName)).toEqual([
      "m",
      "z",
      "b",
      "a",
    ]);
  });
});

describe("connecting accounts", () => {
  const page = { id: "facebook:1", parentId: null };
  const instagram = { id: "instagram:2", parentId: "facebook:1" };
  const other = { id: "facebook:3", parentId: null };
  const accounts = [instagram, other, page];

  it("lists each parent before the accounts that publish through it", () => {
    expect(orderCandidates(accounts).map((account) => account.id)).toEqual([
      "facebook:3",
      "facebook:1",
      "instagram:2",
    ]);
  });

  it("chooses a parent with its child and drops the child with its parent", () => {
    const chosen = toggleCandidate(accounts, new Set(), instagram.id, true);
    expect([...chosen].sort()).toEqual(["facebook:1", "instagram:2"]);
    expect([...toggleCandidate(accounts, chosen, instagram.id, false)]).toEqual(["facebook:1"]);
    expect([...toggleCandidate(accounts, chosen, page.id, false)]).toEqual([]);
  });

  it("offers X only behind its flag", () => {
    expect(connectProviders(false)).toEqual(["meta", "threads"]);
    expect(connectProviders(true)).toEqual(["meta", "threads", "x"]);
  });
});

describe("going live", () => {
  it("takes only the exact phrase", () => {
    expect(confirmsGoLive("publish live")).toBe(true);
    expect(confirmsGoLive("  publish live ")).toBe(true);
    for (const typed of ["", "publish", "Publish live", "publish  live", "publishlive"]) {
      expect(confirmsGoLive(typed)).toBe(false);
    }
  });

  it("lists the server's checks, with a paused publisher only as a warning", () => {
    const channel = mockChannel({
      platform: "threads",
      displayName: "@rustin60",
      connected: true,
      status: "needs_reauth",
      liveBlocker: "not_active",
    });
    const conditions = goLivePreconditions(channel, { mode: "live", enabled: false });
    expect(conditions.map(({ id, met, advisory }) => [id, met, advisory ?? false])).toEqual([
      ["platform", true, false],
      ["connected", true, false],
      ["active", false, false],
      ["server_live", true, false],
      ["publishing_running", false, true],
    ]);
    // Without the publisher's status, the server's blocker says whether it publishes live.
    expect(
      goLivePreconditions({ ...channel, liveBlocker: "publishing_dry_run" }, undefined).find(
        (condition) => condition.id === "server_live",
      )?.met,
    ).toBe(false);
  });
});
