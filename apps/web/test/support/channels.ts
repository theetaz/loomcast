import type { Channel, PublisherStatus } from "@loomcast/contracts";
import { mockChannel } from "@/mocks/calendar";
import { createMockDb, type MockDb } from "@/mocks/db";
import { onlineStudio } from "./kb";

/** The channels tests' clock: Wednesday 14 October 2026, 08:00 UTC. */
export const CHANNELS_NOW = "2026-10-14T08:00:00.000Z";

const CREATED = "2026-10-01T08:00:00.000Z";
const DAY_MS = 24 * 60 * 60_000;

/**
 * A signed-in db with one channel of each kind the switches care about:
 * - `page`: a connected, active Facebook Page (blocked only by the server's dry-run mode);
 * - `planning`: an Instagram planning channel, not connected;
 * - `threads`: a connected Threads profile that needs reconnecting, its access expiring in 4 days;
 * - `x`: an X planning channel, locked to dry-run by its platform.
 */
export function channelsSetup(publisher: Partial<PublisherStatus> = {}) {
  const now = Date.parse(CHANNELS_NOW);
  const page = mockChannel({
    platform: "facebook",
    displayName: "Rust in 60 seconds",
    username: "rustin60",
    connected: true,
    status: "active",
    lastVerifiedAt: new Date(now - 3 * 60 * 60_000).toISOString(),
    createdAt: CREATED,
  });
  const planning = mockChannel({
    platform: "instagram",
    displayName: "@rustin60",
    username: "rustin60",
    createdAt: CREATED,
  });
  const threads = mockChannel({
    platform: "threads",
    displayName: "Rust threads",
    connected: true,
    status: "needs_reauth",
    tokenExpiresAt: new Date(now + 4 * DAY_MS).toISOString(),
    lastError: { code: "auth", retryable: false, message: "The access was revoked." },
    createdAt: CREATED,
  });
  const x = mockChannel({ platform: "x", displayName: "Rust on X", createdAt: CREATED });
  const channels: Channel[] = [page, planning, threads, x];
  const db: MockDb = createMockDb({
    signedIn: true,
    devices: [onlineStudio()],
    channels,
    publisher: {
      mode: "dry-run",
      enabled: true,
      lastTickAt: new Date(now - 30_000).toISOString(),
      ...publisher,
    },
  });
  return { db, channels: { page, planning, threads, x } };
}
