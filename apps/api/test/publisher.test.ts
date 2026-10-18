import diagnostics from "node:diagnostics_channel";
import net from "node:net";
import {
  dryRunPermalink,
  PLATFORMS,
  type Platform,
  type PublishAttempt,
  PublishAttemptSchema,
  type ScheduledPost,
} from "@loomcast/contracts";
import {
  assets,
  auditLog,
  contentItems,
  publishAttempts,
  scheduledPosts,
  scheduledTasks,
} from "@loomcast/db";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ModuleDeps } from "../src/deps";
import { contentServiceFor } from "../src/modules/content";
import {
  type AdapterRegistry,
  bearer,
  buildPublishPlan,
  dryRunMediaUrl,
  PUBLISHING_PAUSED_RETRY_MS,
  type PublishContext,
  type PublisherAdapter,
  PublishFailure,
  type PublishResult,
  REDACTED,
  redactRequest,
  registerPublisherTasks,
  type StatusResult,
  statusPollDelayMs,
  UNCONNECTED_ACCOUNT_ID,
} from "../src/modules/publisher";
import { createScheduler, type Scheduler, type SchedulerAlert } from "../src/modules/scheduler";
import {
  call,
  createPipelineHarness,
  eventsOf,
  insertItem,
  insertProject,
  type PipelineHarness,
} from "./pipeline-support";
import {
  appWith,
  enqueuePublish,
  insertChannel,
  insertPost,
  runDue,
  testKeyring,
} from "./publisher-support";

let h: PipelineHarness;
let projectId: string;
const keyring = testKeyring();
/** The test database's port: the only TCP connections a dry run may open. */
let databasePort: number;

beforeAll(async () => {
  h = await createPipelineHarness();
  projectId = await insertProject(h);
  databasePort = Number(new URL(h.testDb.url).port || 5432);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await h.db.delete(scheduledTasks);
});

afterAll(async () => {
  await h.close();
});

function now(): Date {
  return h.t.clock.now();
}

async function postRow(id: string) {
  const [row] = await h.db.select().from(scheduledPosts).where(eq(scheduledPosts.id, id));
  if (row === undefined) throw new Error(`post ${id} not found`);
  return row;
}

async function attemptsOf(postId: string) {
  return h.db
    .select()
    .from(publishAttempts)
    .where(eq(publishAttempts.postId, postId))
    .orderBy(publishAttempts.attempt);
}

async function itemState(itemId: string) {
  const [row] = await h.db
    .select({ state: contentItems.state })
    .from(contentItems)
    .where(eq(contentItems.id, itemId));
  return row?.state;
}

async function sha256Of(assetId: string | null): Promise<string> {
  if (assetId === null) throw new Error("no asset");
  const [row] = await h.db.select().from(assets).where(eq(assets.id, assetId));
  if (row === undefined) throw new Error("asset not found");
  return row.sha256;
}

async function tasksOf(kind: string) {
  return h.db.select().from(scheduledTasks).where(eq(scheduledTasks.kind, kind));
}

async function auditActions(targetId: string): Promise<string[]> {
  const rows = await h.db.select().from(auditLog).where(eq(auditLog.targetId, targetId));
  return rows.map((row) => row.action);
}

/** A scheduled item with a render, and a queued post of it on `channelId`. */
async function queuedPost(
  channelId: string,
  options: { dryRun?: boolean; state?: "scheduled" | "approved" | "review" } = {},
) {
  const item = await insertItem(h, {
    projectId,
    state: options.state ?? "scheduled",
    level: "render",
  });
  const postId = await insertPost(h.db, {
    itemId: item.itemId,
    versionId: item.versionId,
    channelId,
    scheduledAt: now(),
    dryRun: options.dryRun,
  });
  return { item, postId };
}

/** Post states reported by `post.updated` events for `postId`, in order. */
function postEvents(postId: string): ScheduledPost[] {
  return eventsOf(h.live, "post.updated")
    .map((event) => event.payload.post)
    .filter((post) => post.id === postId);
}

describe("dry-run publishing", () => {
  it("records exactly what each platform's builder sends and publishes the item", async () => {
    const scheduler = h.deps.scheduler;
    for (const platform of PLATFORMS) {
      const channel = await insertChannel(h.db, keyring, { platform });
      const { item, postId } = await queuedPost(channel.id);
      await enqueuePublish(scheduler, postId, now());
      await runDue(scheduler);

      const post = await postRow(postId);
      expect(post).toMatchObject({
        status: "published",
        attempts: 1,
        permalink: dryRunPermalink(platform, postId),
        externalId: null,
        lastError: null,
      });
      expect(post.publishedAt).toEqual(now());
      expect(await itemState(item.itemId)).toBe("published");

      const [attempt, ...others] = await attemptsOf(postId);
      expect(others).toEqual([]);
      expect(attempt).toMatchObject({ attempt: 1, adapter: platform, dryRun: true, error: null });
      const expected = buildPublishPlan({
        request: {
          platform,
          format: "reel",
          externalId: UNCONNECTED_ACCOUNT_ID,
          videoUrl: dryRunMediaUrl(postId, await sha256Of(item.renderAssetId), "mp4"),
          posterUrl: dryRunMediaUrl(postId, await sha256Of(item.posterAssetId), "jpg"),
          caption: "Ownership in sixty seconds\n\n#rust",
          durationMs: 31_000,
          width: 1_080,
          height: 1_920,
        },
        media: { bytes: 1_024, mime: "video/mp4" },
        accessToken: REDACTED,
      });
      expect(attempt?.request).toEqual(redactRequest(expected as never));
      expect(attempt?.response).toEqual({ dryRun: true, permalink: post.permalink });
      expect(attempt?.finishedAt).toEqual(now());

      expect(postEvents(postId).map((event) => event.status)).toEqual(["publishing", "published"]);
      expect(await auditActions(postId)).toEqual(["post.published"]);
    }
  });

  it("publishes a second channel's post of an item that is already published", async () => {
    const first = await insertChannel(h.db, keyring, { platform: "threads" });
    const second = await insertChannel(h.db, keyring, { platform: "facebook" });
    const { item, postId } = await queuedPost(first.id);
    const other = await insertPost(h.db, {
      itemId: item.itemId,
      versionId: item.versionId,
      channelId: second.id,
      scheduledAt: now(),
    });
    await enqueuePublish(h.deps.scheduler, postId, now());
    await enqueuePublish(h.deps.scheduler, other, now());
    await runDue(h.deps.scheduler);
    expect((await postRow(postId)).status).toBe("published");
    expect((await postRow(other)).status).toBe("published");
    expect(await itemState(item.itemId)).toBe("published");
  });

  it("schedules and publishes an item the calendar left approved", async () => {
    const channel = await insertChannel(h.db, keyring);
    const { item, postId } = await queuedPost(channel.id, { state: "approved" });
    await enqueuePublish(h.deps.scheduler, postId, now());
    await runDue(h.deps.scheduler);
    expect((await postRow(postId)).status).toBe("published");
    expect(await itemState(item.itemId)).toBe("published");
  });

  it("never opens a connection, promotes media or reads credentials", async () => {
    // A server in dry-run mode, with channels that are connected and switched to live, and posts
    // created live: the server's mode alone must keep everything on the server.
    const connects: unknown[] = [];
    // Every fetch goes through undici, which reports each request and connection here.
    const undiciEvents: string[] = [];
    const channelNames = ["undici:request:create", "undici:client:beforeConnect"];
    const onUndici = (_message: unknown, name: string | symbol) => {
      undiciEvents.push(String(name));
    };
    for (const name of channelNames) diagnostics.subscribe(name, onUndici);
    const connect = net.Socket.prototype.connect;
    vi.spyOn(net.Socket.prototype, "connect").mockImplementation(function (
      this: net.Socket,
      ...args: unknown[]
    ) {
      connects.push(args[0]);
      return (connect as (...a: unknown[]) => net.Socket).apply(this, args);
    });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("dry-run publishing must not fetch"));
    const promote = vi.spyOn(h.deps.storage, "promoteToPublic");
    const presign = vi.spyOn(h.deps.storage, "presignGet");
    const decrypt = vi.spyOn(h.deps.vault, "decrypt");

    const posts: string[] = [];
    for (const platform of PLATFORMS) {
      const channel = await insertChannel(h.db, keyring, {
        platform,
        connected: true,
        dryRun: false,
      });
      const { postId } = await queuedPost(channel.id, { dryRun: false });
      posts.push(postId);
      await enqueuePublish(h.deps.scheduler, postId, now());
    }
    try {
      await runDue(h.deps.scheduler);
    } finally {
      for (const name of channelNames) diagnostics.unsubscribe(name, onUndici);
    }

    for (const postId of posts) {
      const post = await postRow(postId);
      expect(post.status).toBe("published");
      expect(post.permalink?.startsWith("dryrun://")).toBe(true);
      const [attempt] = await attemptsOf(postId);
      expect(attempt?.dryRun).toBe(true);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(undiciEvents).toEqual([]);
    expect(promote).not.toHaveBeenCalled();
    expect(presign).not.toHaveBeenCalled();
    expect(decrypt).not.toHaveBeenCalled();
    const ports = connects.map((target) => {
      const options = Array.isArray(target) ? target[0] : target;
      if (typeof options === "number") return options;
      if (typeof options === "object" && options !== null && "port" in options) {
        return Number((options as { port: unknown }).port);
      }
      return options;
    });
    expect(ports.filter((port) => port !== databasePort)).toEqual([]);
  });
});

describe("statuses", () => {
  it("marks a planned post missed with an event and an audit row", async () => {
    const channel = await insertChannel(h.db, keyring);
    const item = await insertItem(h, { projectId, state: "script", level: "script" });
    const postId = await insertPost(h.db, {
      itemId: item.itemId,
      versionId: null,
      channelId: channel.id,
      scheduledAt: now(),
      status: "planned",
    });
    await enqueuePublish(h.deps.scheduler, postId, now());
    await runDue(h.deps.scheduler);
    expect(await postRow(postId)).toMatchObject({ status: "missed", attempts: 0 });
    expect(await attemptsOf(postId)).toEqual([]);
    expect(postEvents(postId).map((post) => post.status)).toEqual(["missed"]);
    expect(await auditActions(postId)).toEqual(["post.missed"]);
    expect(await itemState(item.itemId)).toBe("script");
  });

  it("leaves cancelled and finished posts alone", async () => {
    const channel = await insertChannel(h.db, keyring);
    const ids: string[] = [];
    for (const status of ["cancelled", "failed", "missed"] as const) {
      const item = await insertItem(h, { projectId, state: "scheduled", level: "render" });
      ids.push(
        await insertPost(h.db, {
          itemId: item.itemId,
          versionId: item.versionId,
          channelId: channel.id,
          scheduledAt: now(),
          status,
        }),
      );
    }
    for (const id of ids) await enqueuePublish(h.deps.scheduler, id, now());
    await runDue(h.deps.scheduler);
    expect((await Promise.all(ids.map(postRow))).map((post) => post.status)).toEqual([
      "cancelled",
      "failed",
      "missed",
    ]);
    for (const id of ids) expect(await attemptsOf(id)).toEqual([]);
    expect((await tasksOf("post.publish")).map((task) => task.status)).toEqual([
      "succeeded",
      "succeeded",
      "succeeded",
    ]);
  });

  it("waits 15 minutes while publishing is paused", async () => {
    const paused = appWith(h.db, {
      clock: h.t.clock,
      config: { publishing: { mode: "dry-run", enabled: false } },
    });
    try {
      const channel = await insertChannel(h.db, keyring);
      const { postId } = await queuedPost(channel.id);
      await enqueuePublish(paused.deps.scheduler, postId, now());
      await runDue(paused.deps.scheduler);
      expect(await postRow(postId)).toMatchObject({ status: "queued", attempts: 0 });
      const pending = (await tasksOf("post.publish")).filter((task) => task.status === "pending");
      expect(pending).toHaveLength(1);
      expect(pending[0]?.runAt).toEqual(new Date(now().getTime() + PUBLISHING_PAUSED_RETRY_MS));
      expect(pending[0]?.dedupeKey).toBe(`publish:${postId}`);
    } finally {
      await paused.t.deps.lifecycle.close();
    }
  });

  it("restarts an attempt that was interrupted before it recorded an outcome", async () => {
    const channel = await insertChannel(h.db, keyring);
    const { postId } = await queuedPost(channel.id);
    await h.db
      .update(scheduledPosts)
      .set({ status: "publishing", attempts: 1 })
      .where(eq(scheduledPosts.id, postId));
    await h.db
      .insert(publishAttempts)
      .values({ postId, attempt: 1, adapter: "instagram", dryRun: true, startedAt: now() });
    await enqueuePublish(h.deps.scheduler, postId, now());
    await runDue(h.deps.scheduler);
    expect(await postRow(postId)).toMatchObject({ status: "published", attempts: 2 });
    const attempts = await attemptsOf(postId);
    expect(attempts.map((attempt) => [attempt.attempt, attempt.error?.code ?? null])).toEqual([
      [1, "transient"],
      [2, null],
    ]);
  });
});

describe("gates", () => {
  it("fails a post whose item is not approved in the post's version", async () => {
    const channel = await insertChannel(h.db, keyring);
    const { postId, item } = await queuedPost(channel.id, { state: "review" });
    await enqueuePublish(h.deps.scheduler, postId, now());
    await runDue(h.deps.scheduler);
    const post = await postRow(postId);
    expect(post).toMatchObject({ status: "failed", attempts: 0 });
    expect(post.lastError).toMatchObject({ code: "permanent", retryable: false });
    expect(await itemState(item.itemId)).toBe("review");
    expect(await auditActions(postId)).toEqual(["post.failed"]);
    expect(h.t.logs.some((line) => line.includes("post failed to publish"))).toBe(true);
  });

  it("fails a post on a disabled channel", async () => {
    const channel = await insertChannel(h.db, keyring, { status: "disabled" });
    const { postId } = await queuedPost(channel.id);
    await enqueuePublish(h.deps.scheduler, postId, now());
    await runDue(h.deps.scheduler);
    expect((await postRow(postId)).lastError).toMatchObject({ code: "not_configured" });
  });

  it("fails a render-less version as invalid media", async () => {
    const channel = await insertChannel(h.db, keyring);
    const item = await insertItem(h, { projectId, state: "scheduled", level: "voice" });
    const postId = await insertPost(h.db, {
      itemId: item.itemId,
      versionId: item.versionId,
      channelId: channel.id,
      scheduledAt: now(),
    });
    await enqueuePublish(h.deps.scheduler, postId, now());
    await runDue(h.deps.scheduler);
    expect((await postRow(postId)).lastError).toMatchObject({ code: "invalid_media" });
  });
});

/** A live adapter whose answers the test scripts. */
function fakeAdapter(
  platform: Platform,
  script: {
    publish?: (context: Parameters<PublisherAdapter["publish"]>[0]) => Promise<PublishResult>;
    status?: () => Promise<StatusResult>;
  },
) {
  const adapter = {
    platform,
    validate: vi.fn(async () => []),
    publish: vi.fn(
      script.publish ??
        (async (): Promise<PublishResult> => ({ pending: false, permalink: "https://x.test/p" })),
    ),
    status: vi.fn(script.status ?? (async (): Promise<StatusResult> => ({ state: "pending" }))),
  };
  return adapter;
}

interface LiveHarness {
  deps: ModuleDeps;
  scheduler: Scheduler;
  alerts: SchedulerAlert[];
  close(): Promise<void>;
}

/** A server publishing live, whose publisher tasks run on a scheduler with `adapter`. */
function liveServer(
  adapter: PublisherAdapter,
  options: { dailyLimits?: Partial<Record<Platform, number>> } = {},
): LiveHarness {
  const { t, deps } = appWith(h.db, {
    clock: h.t.clock,
    config: { publishing: { mode: "live", enabled: true }, encryption: keyring },
  });
  t.bus.subscribeLive((event) => void h.live.push(event));
  const alerts: SchedulerAlert[] = [];
  const scheduler = createScheduler({
    db: h.db,
    bus: t.bus,
    clock: h.t.clock,
    logger: deps.logger,
    config: { enabled: true, tickMs: 5_000 },
    random: () => 0.5,
  });
  const adapters = { instagram: adapter, facebook: adapter, threads: adapter, x: adapter };
  registerPublisherTasks({
    ...deps,
    scheduler,
    content: contentServiceFor(deps),
    adapters: adapters as AdapterRegistry,
    alert: (alert) => void alerts.push(alert),
    dailyLimits: options.dailyLimits,
  });
  return {
    deps,
    scheduler,
    alerts,
    close: async () => {
      await scheduler.stop(1_000);
      await t.deps.lifecycle.close();
    },
  };
}

async function liveChannel(options: { status?: "active" | "needs_reauth"; dryRun?: boolean } = {}) {
  return insertChannel(h.db, keyring, {
    connected: true,
    status: options.status ?? "active",
    dryRun: options.dryRun ?? false,
  });
}

describe("live publishing with a fake adapter", () => {
  it("decrypts credentials lazily and stores the request redacted", async () => {
    const adapter = fakeAdapter("instagram", {
      publish: async (context) => {
        const credentials = await context.secrets();
        context.record({
          request: {
            headers: { Authorization: bearer(credentials.accessToken) },
            body: { caption: context.caption().text },
          },
          response: { id: "m-1" },
        });
        return {
          pending: false,
          permalink: "https://www.instagram.com/reel/abc/",
          externalId: "m-1",
        };
      },
    });
    const live = liveServer(adapter);
    try {
      const channel = await liveChannel();
      const { postId } = await queuedPost(channel.id, { dryRun: false });
      await enqueuePublish(live.scheduler, postId, now());
      await runDue(live.scheduler);

      expect(adapter.publish).toHaveBeenCalledTimes(1);
      expect(await postRow(postId)).toMatchObject({
        status: "published",
        externalId: "m-1",
        permalink: "https://www.instagram.com/reel/abc/",
      });
      const [attempt] = await attemptsOf(postId);
      expect(attempt).toMatchObject({ dryRun: false, adapter: "instagram" });
      expect(attempt?.request).toEqual({
        headers: { Authorization: `Bearer ${REDACTED}` },
        body: { caption: "Ownership in sixty seconds\n\n#rust" },
      });

      const token = channel.token ?? "";
      const response = await call(h, "GET", `/api/scheduled-posts/${postId}/attempts`);
      const body = await response.text();
      expect(response.status).toBe(200);
      expect(body).not.toContain(token);
      expect(JSON.stringify(h.live)).not.toContain(token);
      expect(h.t.logs.join("\n")).not.toContain(token);
    } finally {
      await live.close();
    }
  });

  it("keeps a post in dry-run when its channel switched back to dry-run", async () => {
    const adapter = fakeAdapter("instagram", {});
    const live = liveServer(adapter);
    try {
      const channel = await liveChannel({ dryRun: true });
      const { postId } = await queuedPost(channel.id, { dryRun: false });
      await enqueuePublish(live.scheduler, postId, now());
      await runDue(live.scheduler);
      expect(adapter.publish).not.toHaveBeenCalled();
      expect((await postRow(postId)).permalink).toBe(dryRunPermalink("instagram", postId));
    } finally {
      await live.close();
    }
  });

  it("fails a live post on a channel that needs reconnecting", async () => {
    const adapter = fakeAdapter("instagram", {});
    const live = liveServer(adapter);
    try {
      const channel = await liveChannel({ status: "needs_reauth" });
      const { postId } = await queuedPost(channel.id, { dryRun: false });
      await enqueuePublish(live.scheduler, postId, now());
      await runDue(live.scheduler);
      expect(adapter.publish).not.toHaveBeenCalled();
      expect((await postRow(postId)).lastError).toMatchObject({ code: "auth", retryable: false });
      expect(live.alerts.map((alert) => alert.key)).toEqual([`post.failed:${postId}`]);
    } finally {
      await live.close();
    }
  });

  it("holds a post back while its channel is at its daily limit", async () => {
    const adapter = fakeAdapter("instagram", {});
    const live = liveServer(adapter, { dailyLimits: { instagram: 1 } });
    try {
      const channel = await liveChannel();
      const earlier = await queuedPost(channel.id, { dryRun: false });
      await h.db.insert(publishAttempts).values({
        postId: earlier.postId,
        attempt: 1,
        adapter: "instagram",
        dryRun: false,
        startedAt: new Date(now().getTime() - 60 * 60_000),
      });
      const { postId } = await queuedPost(channel.id, { dryRun: false });
      await enqueuePublish(live.scheduler, postId, now());
      await runDue(live.scheduler);

      expect(adapter.publish).not.toHaveBeenCalled();
      const post = await postRow(postId);
      expect(post).toMatchObject({ status: "queued", attempts: 0 });
      expect(post.lastError).toMatchObject({ code: "rate_limited", retryAfterMs: 23 * 3_600_000 });
      const [pending] = (await tasksOf("post.publish")).filter((task) => task.status === "pending");
      expect(pending?.runAt).toEqual(new Date(now().getTime() + 23 * 3_600_000));
    } finally {
      await live.close();
    }
  });

  it("retries a retryable failure and fails the post on a permanent one", async () => {
    let calls = 0;
    const adapter = fakeAdapter("instagram", {
      publish: async () => {
        calls += 1;
        throw calls === 1
          ? PublishFailure.of("transient", "The platform timed out.")
          : PublishFailure.of("permission", "The token lacks a permission.", {
              platformCode: "10",
            });
      },
    });
    const live = liveServer(adapter);
    try {
      const channel = await liveChannel();
      const { postId } = await queuedPost(channel.id, { dryRun: false });
      await enqueuePublish(live.scheduler, postId, now());
      await runDue(live.scheduler);

      expect(await postRow(postId)).toMatchObject({ status: "queued", attempts: 1 });
      expect((await postRow(postId)).lastError).toMatchObject({ code: "transient" });
      const [task] = await tasksOf("post.publish");
      expect(task).toMatchObject({ status: "pending", attempts: 1 });
      expect(task?.runAt).toEqual(new Date(now().getTime() + 60_000));

      h.t.clock.advance(60_000);
      await runDue(live.scheduler);
      const post = await postRow(postId);
      expect(post).toMatchObject({ status: "failed", attempts: 2 });
      expect(post.lastError).toMatchObject({ code: "permission", retryable: false });
      const attempts = await attemptsOf(postId);
      expect(attempts.map((attempt) => [attempt.attempt, attempt.error?.code])).toEqual([
        [1, "transient"],
        [2, "permission"],
      ]);
      expect((await tasksOf("post.publish"))[0]?.status).toBe("succeeded");
      expect(live.alerts).toEqual([
        expect.objectContaining({
          key: `post.failed:${postId}`,
          data: expect.objectContaining({ postId, code: "permission" }),
        }),
      ]);
      expect(postEvents(postId).map((event) => event.status)).toEqual([
        "publishing",
        "queued",
        "publishing",
        "failed",
      ]);
    } finally {
      await live.close();
    }
  });

  it("fails the post when the last task attempt fails retryably", async () => {
    const adapter = fakeAdapter("instagram", {
      publish: async () => {
        throw PublishFailure.of("rate_limited", "Slow down.", { retryAfterMs: 1_000 });
      },
    });
    const live = liveServer(adapter);
    try {
      const channel = await liveChannel();
      const { postId } = await queuedPost(channel.id, { dryRun: false });
      await enqueuePublish(live.scheduler, postId, now());
      for (let run = 0; run < 5; run += 1) {
        await runDue(live.scheduler);
        h.t.clock.advance(1_000);
      }
      expect(adapter.publish).toHaveBeenCalledTimes(5);
      expect(await postRow(postId)).toMatchObject({ status: "failed", attempts: 5 });
      expect((await tasksOf("post.publish"))[0]?.status).toBe("succeeded");
    } finally {
      await live.close();
    }
  });

  it("polls a pending post until the platform publishes it", async () => {
    const statuses: StatusResult[] = [
      { state: "pending" },
      { state: "published", permalink: "https://www.threads.net/@a/post/1", externalId: "t-1" },
    ];
    const adapter = fakeAdapter("instagram", {
      publish: async () => ({ pending: true, containerId: "c-1" }),
      status: async () => statuses.shift() ?? { state: "pending" },
    });
    const live = liveServer(adapter);
    try {
      const channel = await liveChannel();
      const { postId, item } = await queuedPost(channel.id, { dryRun: false });
      const started = now();
      await enqueuePublish(live.scheduler, postId, now());
      await runDue(live.scheduler);

      expect(await postRow(postId)).toMatchObject({
        status: "publishing",
        externalContainerId: "c-1",
      });
      const [poll] = await tasksOf("post.check_status");
      expect(poll).toMatchObject({ status: "pending", dedupeKey: `status:${postId}` });
      expect(poll?.payload).toEqual({ postId, since: started.toISOString() });
      expect(poll?.runAt).toEqual(new Date(started.getTime() + 15_000));
      expect((await attemptsOf(postId))[0]?.finishedAt).toBeNull();

      h.t.clock.advance(15_000);
      await runDue(live.scheduler);
      expect(adapter.status).toHaveBeenCalledTimes(1);
      const next = (await tasksOf("post.check_status")).find((task) => task.status === "pending");
      expect(next?.runAt).toEqual(new Date(now().getTime() + 15_000));

      h.t.clock.advance(15_000);
      await runDue(live.scheduler);
      expect(adapter.status).toHaveBeenCalledTimes(2);
      expect(await postRow(postId)).toMatchObject({
        status: "published",
        permalink: "https://www.threads.net/@a/post/1",
        externalId: "t-1",
        externalContainerId: "c-1",
      });
      expect((await attemptsOf(postId))[0]?.finishedAt).toEqual(now());
      expect(await itemState(item.itemId)).toBe("published");
    } finally {
      await live.close();
    }
  });

  it("follows the new container a status poll hands back", async () => {
    const seen: (string | null)[] = [];
    const statuses: StatusResult[] = [
      { state: "pending", containerId: "c-parent" },
      { state: "published", externalId: "m-1" },
    ];
    const adapter = {
      ...fakeAdapter("instagram", {
        publish: async () => ({ pending: true, containerId: "items:c-1,c-2" }),
      }),
      status: vi.fn(async (context: PublishContext): Promise<StatusResult> => {
        seen.push(context.post.externalContainerId);
        return statuses.shift() ?? { state: "pending" };
      }),
    };
    const live = liveServer(adapter);
    try {
      const channel = await liveChannel();
      const { postId } = await queuedPost(channel.id, { dryRun: false });
      await enqueuePublish(live.scheduler, postId, now());
      await runDue(live.scheduler);
      h.t.clock.advance(15_000);
      await runDue(live.scheduler);
      expect(await postRow(postId)).toMatchObject({
        status: "publishing",
        externalContainerId: "c-parent",
      });
      h.t.clock.advance(15_000);
      await runDue(live.scheduler);
      expect(seen).toEqual(["items:c-1,c-2", "c-parent"]);
      expect(await postRow(postId)).toMatchObject({
        status: "published",
        externalId: "m-1",
        externalContainerId: "c-parent",
      });
    } finally {
      await live.close();
    }
  });

  it("fails a post the platform still processes after 20 minutes", async () => {
    const adapter = fakeAdapter("instagram", {
      publish: async () => ({ pending: true, containerId: "c-2" }),
      status: async () => ({ state: "pending" }),
    });
    const live = liveServer(adapter);
    try {
      const channel = await liveChannel();
      const { postId } = await queuedPost(channel.id, { dryRun: false });
      await enqueuePublish(live.scheduler, postId, now());
      await runDue(live.scheduler);
      h.t.clock.advance(20 * 60_000);
      await runDue(live.scheduler);
      const post = await postRow(postId);
      expect(post.status).toBe("failed");
      expect(post.lastError).toMatchObject({ code: "transient", retryable: false });
      expect((await attemptsOf(postId))[0]?.error).toMatchObject({ code: "transient" });
    } finally {
      await live.close();
    }
  });

  it("fails a post the platform refuses while processing", async () => {
    const adapter = fakeAdapter("instagram", {
      publish: async () => ({ pending: true, containerId: "c-3" }),
      status: async () => ({
        state: "failed",
        error: {
          code: "invalid_media",
          retryable: false,
          platformCode: "2207026",
          message: "ERROR",
        },
      }),
    });
    const live = liveServer(adapter);
    try {
      const channel = await liveChannel();
      const { postId } = await queuedPost(channel.id, { dryRun: false });
      await enqueuePublish(live.scheduler, postId, now());
      await runDue(live.scheduler);
      h.t.clock.advance(15_000);
      await runDue(live.scheduler);
      expect((await postRow(postId)).lastError).toMatchObject({
        code: "invalid_media",
        platformCode: "2207026",
      });
    } finally {
      await live.close();
    }
  });

  it("backs status polls off from 15 s to 60 s", () => {
    expect(statusPollDelayMs(0)).toBe(15_000);
    expect(statusPollDelayMs(60_000)).toBe(15_000);
    expect(statusPollDelayMs(120_000)).toBe(30_000);
    expect(statusPollDelayMs(10 * 60_000)).toBe(60_000);
  });

  it("refuses live posts through the stub adapters with not_configured", async () => {
    const { t, deps } = appWith(h.db, {
      clock: h.t.clock,
      config: { publishing: { mode: "live", enabled: true }, encryption: keyring },
    });
    try {
      const channel = await liveChannel();
      const { postId } = await queuedPost(channel.id, { dryRun: false });
      await enqueuePublish(deps.scheduler, postId, now());
      await runDue(deps.scheduler);
      expect((await postRow(postId)).lastError).toMatchObject({
        code: "not_configured",
        retryable: false,
      });
    } finally {
      await t.deps.lifecycle.close();
    }
  });
});

describe("endpoints", () => {
  it("reports the publisher status", async () => {
    const response = await call(h, "GET", "/api/publisher/status");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      mode: "dry-run",
      enabled: true,
      lastTickAt: h.deps.scheduler.health().lastTickAt,
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("lists a post's attempts newest first and 404s unknown posts", async () => {
    const channel = await insertChannel(h.db, keyring);
    const { postId } = await queuedPost(channel.id);
    await h.db.insert(publishAttempts).values(
      [1, 2].map((attempt) => ({
        postId,
        attempt,
        adapter: "instagram" as const,
        dryRun: true,
        startedAt: now(),
      })),
    );
    const response = await call(h, "GET", `/api/scheduled-posts/${postId}/attempts`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: PublishAttempt[] };
    expect(body.items.map((attempt) => PublishAttemptSchema.parse(attempt).attempt)).toEqual([
      2, 1,
    ]);
    const missing = await call(h, "GET", `/api/scheduled-posts/${crypto.randomUUID()}/attempts`);
    expect(missing.status).toBe(404);
  });

  it("needs a session", async () => {
    const response = await h.t.app.request("/api/publisher/status");
    expect(response.status).toBe(401);
  });
});
