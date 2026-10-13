import { randomBytes, randomUUID } from "node:crypto";
import type { ChannelStatus, Platform, PostStatus } from "@loomcast/contracts";
import { channels, type Database, scheduledPosts } from "@loomcast/db";
import type { ModuleDeps } from "../src/deps";
import type { Config } from "../src/env";
import { channelAad, createVault, type VaultKeyring } from "../src/lib/vault";
import type { Scheduler } from "../src/modules/scheduler";
import { createTestApp, type TestApp, type TestClock } from "./support";

/** A keyring generated per run, shared by every app of a test file. */
export function testKeyring(): VaultKeyring {
  return { keyVersion: 1, key: randomBytes(32), previousKeys: new Map() };
}

/** Another app on the same database, with its module deps captured. */
export function appWith(
  db: Database,
  options: { config?: Partial<Config>; clock?: TestClock },
): { t: TestApp; deps: ModuleDeps } {
  let deps: ModuleDeps | undefined;
  const t = createTestApp(db, {
    ...options,
    modules: [
      (app, moduleDeps) => {
        deps = moduleDeps;
        return app;
      },
    ],
  });
  if (deps === undefined) {
    throw new Error("module deps were not captured");
  }
  return { t, deps };
}

export interface ChannelSpec {
  platform?: Platform;
  status?: ChannelStatus;
  dryRun?: boolean;
  connected?: boolean;
  displayName?: string;
  requiresApproval?: boolean;
}

export interface InsertedChannel {
  id: string;
  platform: Platform;
  externalId: string | null;
  /** The access token sealed on the row, for connected channels. */
  token: string | null;
}

/** Inserts a channel; connected ones get an access token sealed with `keyring`. */
export async function insertChannel(
  db: Database,
  keyring: VaultKeyring,
  spec: ChannelSpec = {},
): Promise<InsertedChannel> {
  const id = randomUUID();
  const platform = spec.platform ?? "instagram";
  const connected = spec.connected ?? false;
  const token = connected ? `tok-${randomUUID()}` : null;
  const sealed =
    token === null ? null : createVault(keyring).encrypt({ accessToken: token }, channelAad(id));
  const externalId = connected ? String(17_000_000_000 + Math.floor(Math.random() * 1e9)) : null;
  await db.insert(channels).values({
    id,
    platform,
    displayName: spec.displayName ?? `${platform} channel`,
    externalId,
    status: spec.status ?? (connected ? "active" : "disconnected"),
    dryRun: spec.dryRun ?? true,
    requiresApproval: spec.requiresApproval ?? false,
    secretCiphertext: sealed?.secretCiphertext ?? null,
    secretNonce: sealed?.secretNonce ?? null,
    keyVersion: sealed?.keyVersion ?? null,
  });
  return { id, platform, externalId, token };
}

export async function insertPost(
  db: Database,
  values: {
    itemId: string;
    versionId: string | null;
    channelId: string;
    scheduledAt: Date;
    status?: PostStatus;
    dryRun?: boolean;
    seriesId?: string | null;
  },
): Promise<string> {
  const [row] = await db
    .insert(scheduledPosts)
    .values({
      itemId: values.itemId,
      versionId: values.status === "planned" ? null : values.versionId,
      channelId: values.channelId,
      seriesId: values.seriesId ?? null,
      scheduledAt: values.scheduledAt,
      status: values.status ?? "queued",
      dryRun: values.dryRun ?? true,
    })
    .returning({ id: scheduledPosts.id });
  if (row === undefined) {
    throw new Error("post was not inserted");
  }
  return row.id;
}

/** Enqueues the post's publish task the way the calendar does. */
export async function enqueuePublish(
  scheduler: Scheduler,
  postId: string,
  runAt: Date,
): Promise<void> {
  await scheduler.enqueue("post.publish", { postId }, { runAt, dedupeKey: `publish:${postId}` });
}

/** Claims and runs every task due now, until none is left. */
export async function runDue(scheduler: Scheduler): Promise<void> {
  for (let round = 0; round < 50; round += 1) {
    const claimed = await scheduler.tick();
    await scheduler.idle();
    if (claimed === 0) {
      return;
    }
  }
  throw new Error("tasks kept coming due");
}
