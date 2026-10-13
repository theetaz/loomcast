import { channels } from "@loomcast/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { flagNeedsReauth } from "../src/modules/channels/reauth";
import { PublishFailure, THREADS_VIDEO_LIMITS } from "../src/modules/publisher";
import type {
  CredentialsRefusal,
  MetaAdapterOptions,
} from "../src/modules/publisher/adapters/facebook";
import {
  assertThreadsQuota,
  createThreadsAdapter,
  THREADS_QUOTA_RETRY_MS,
} from "../src/modules/publisher/adapters/threads";
import {
  dryRunParity,
  type FakeContext,
  fakeContext,
  graphErrorBody,
  scriptedFetch,
  testPlatforms,
} from "./meta-publisher-support";
import { fakeId } from "./oauth-support";
import { createPipelineHarness, type PipelineHarness } from "./pipeline-support";
import { insertChannel, testKeyring } from "./publisher-support";

// Threads video posts: every Threads API call is answered by a scripted fetch.

const V = "/v1.0";

function adapterWith(
  fake: ReturnType<typeof scriptedFetch>,
  overrides: Partial<MetaAdapterOptions> = {},
) {
  const refusals: CredentialsRefusal[] = [];
  const adapter = createThreadsAdapter({
    // Threads posts need no Meta app: the Threads API takes no appsecret_proof.
    platforms: testPlatforms({ metaApp: false }),
    fetch: fake.fetch,
    sleep: async () => {},
    onCredentialsRefused: async (refusal) => {
      refusals.push(refusal);
    },
    ...overrides,
  });
  return { adapter, refusals };
}

const limitPath = (context: FakeContext) =>
  `${V}/${context.request.externalId}/threads_publishing_limit`;
const threadsPath = (context: FakeContext) => `${V}/${context.request.externalId}/threads`;
const publishPath = (context: FakeContext) => `${V}/${context.channel.externalId}/threads_publish`;

function quota(usage: number, total = 250, duration = 86_400) {
  return {
    body: {
      data: [{ quota_usage: usage, config: { quota_total: total, quota_duration: duration } }],
    },
  };
}

describe("threads validation", () => {
  it("checks the video limits without calling the platform", async () => {
    const fake = scriptedFetch();
    const { adapter } = adapterWith(fake);
    expect(await adapter.validate(fakeContext("threads"))).toEqual([]);
    const long = await adapter.validate(
      fakeContext("threads", { durationMs: THREADS_VIDEO_LIMITS.maxDurationMs + 1_000 }),
    );
    expect(long.map((issue) => issue.field)).toContain("duration");
    const large = await adapter.validate(
      fakeContext("threads", { bytes: THREADS_VIDEO_LIMITS.maxBytes + 1 }),
    );
    expect(large.map((issue) => issue.field)).toContain("size");
    expect(fake.calls).toHaveLength(0);
  });
});

describe("threads publish", () => {
  it("checks the quota, then creates a VIDEO container", async () => {
    const fake = scriptedFetch();
    const { adapter, refusals } = adapterWith(fake);
    const context = fakeContext("threads");
    const containerId = fakeId();
    fake.on("GET", limitPath(context), quota(4)).on("POST", threadsPath(context), {
      body: { id: containerId },
    });

    expect(await adapter.publish(context)).toEqual({ pending: true, containerId });
    const [limit, create] = fake.calls;
    expect(limit?.url.searchParams.get("fields")).toBe("quota_usage,config");
    expect(limit?.url.searchParams.get("access_token")).toBe(context.token);
    expect(limit?.url.searchParams.has("appsecret_proof")).toBe(false);
    expect(Object.fromEntries(create?.form ?? [])).toEqual({
      media_type: "VIDEO",
      video_url: context.request.videoUrl,
      text: context.request.caption,
      access_token: context.token,
    });
    expect(create?.headers.get("authorization")).toBeNull();
    expect(context.recorded.response).toEqual({ container_id: containerId });
    expect(refusals).toEqual([]);
  });

  it("records the same plan as the dry-run adapter", async () => {
    const fake = scriptedFetch();
    const { adapter } = adapterWith(fake);
    const context = fakeContext("threads");
    fake.on("GET", limitPath(context), quota(0)).on("POST", threadsPath(context), {
      body: { id: fakeId() },
    });
    await adapter.publish(context);
    const { dryRun, live } = await dryRunParity(context);
    expect(live).toBeDefined();
    expect(live).toEqual(dryRun);
    expect(JSON.stringify(live)).not.toContain(context.token);
  });

  it("keeps the text within 500 characters", async () => {
    const fake = scriptedFetch();
    const { adapter } = adapterWith(fake);
    const context = fakeContext("threads", { caption: "word ".repeat(400) });
    fake.on("GET", limitPath(context), quota(0)).on("POST", threadsPath(context), {
      body: { id: fakeId() },
    });
    await adapter.publish(context);
    const text = fake.calls[1]?.form.get("text") ?? "";
    expect(text.length).toBeGreaterThan(0);
    expect([...text].length).toBeLessThanOrEqual(500);
  });

  it("waits when the quota is used up, without creating a container", async () => {
    const fake = scriptedFetch();
    const { adapter, refusals } = adapterWith(fake);
    const context = fakeContext("threads");
    fake.on("GET", limitPath(context), quota(250));

    const failure = await adapter.publish(context).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PublishFailure);
    expect((failure as PublishFailure).error).toMatchObject({
      code: "rate_limited",
      retryable: true,
      retryAfterMs: THREADS_QUOTA_RETRY_MS,
    });
    expect(fake.calls).toHaveLength(1);
    expect(context.recorded.response).toEqual({ quota_usage: 250, quota_total: 250 });
    expect(refusals).toEqual([]);
  });

  it("reads the quota defensively", () => {
    expect(() => assertThreadsQuota({ data: [] })).not.toThrow();
    expect(() =>
      assertThreadsQuota({
        data: [{ quota_usage: 3, config: { quota_total: 3, quota_duration: 600 } }],
      }),
    ).toThrow(
      expect.objectContaining({ error: expect.objectContaining({ retryAfterMs: 600_000 }) }),
    );
  });

  it("maps a throttled quota check to rate_limited", async () => {
    const fake = scriptedFetch();
    const { adapter } = adapterWith(fake);
    const context = fakeContext("threads");
    fake.on("GET", limitPath(context), { status: 400, body: graphErrorBody(4, "Too many calls") });
    await expect(adapter.publish(context)).rejects.toMatchObject({
      error: { code: "rate_limited" },
    });
    expect(fake.calls).toHaveLength(1);
  });
});

describe("threads status", () => {
  function pendingContext() {
    return fakeContext("threads", { externalContainerId: fakeId() });
  }
  const containerPath = (context: FakeContext) => `${V}/${context.post.externalContainerId}`;

  it("stays pending while the container is in progress", async () => {
    const fake = scriptedFetch();
    const { adapter } = adapterWith(fake);
    const context = pendingContext();
    fake.on("GET", containerPath(context), { body: { status: "IN_PROGRESS" } });
    expect(await adapter.status(context)).toEqual({ state: "pending" });
    expect(fake.calls[0]?.url.searchParams.get("fields")).toBe("status,error_message");
    expect(fake.calls).toHaveLength(1);
  });

  it("publishes a FINISHED container and reads its permalink", async () => {
    const fake = scriptedFetch();
    const { adapter } = adapterWith(fake);
    const context = pendingContext();
    const mediaId = fakeId();
    const permalink = `https://www.threads.com/@loomcast/post/${mediaId}`;
    fake
      .on("GET", containerPath(context), { body: { status: "FINISHED" } })
      .on("POST", publishPath(context), { body: { id: mediaId } })
      .on("GET", `${V}/${mediaId}`, { body: { id: mediaId, permalink } });

    expect(await adapter.status(context)).toEqual({
      state: "published",
      externalId: mediaId,
      permalink,
    });
    const publish = fake.calls[1];
    expect(Object.fromEntries(publish?.form ?? [])).toEqual({
      creation_id: context.post.externalContainerId,
      access_token: context.token,
    });
    expect(fake.calls[2]?.url.searchParams.get("fields")).toBe("permalink");
    expect(context.recorded.response).toMatchObject({ status: "FINISHED", media_id: mediaId });
  });

  it("publishes without a permalink when the permalink read fails", async () => {
    const fake = scriptedFetch();
    const { adapter } = adapterWith(fake);
    const context = pendingContext();
    const mediaId = fakeId();
    fake
      .on("GET", containerPath(context), { body: { status: "FINISHED" } })
      .on("POST", publishPath(context), { body: { id: mediaId } })
      .on("GET", `${V}/${mediaId}`, { status: 400, body: graphErrorBody(100, "Unsupported") });
    expect(await adapter.status(context)).toEqual({ state: "published", externalId: mediaId });
  });

  it("fails an ERROR container as invalid_media with the platform's reason", async () => {
    const fake = scriptedFetch();
    const { adapter } = adapterWith(fake);
    const context = pendingContext();
    fake.on("GET", containerPath(context), {
      body: { status: "ERROR", error_message: "INVALID_DURATION" },
    });
    expect(await adapter.status(context)).toMatchObject({
      state: "failed",
      error: { code: "invalid_media", retryable: false, platformCode: "INVALID_DURATION" },
    });
    expect(fake.calls).toHaveLength(1);
  });

  it("fails an EXPIRED container as permanent", async () => {
    const fake = scriptedFetch();
    const { adapter } = adapterWith(fake);
    const context = pendingContext();
    fake.on("GET", containerPath(context), { body: { status: "EXPIRED" } });
    expect(await adapter.status(context)).toMatchObject({
      state: "failed",
      error: { code: "permanent", platformCode: "EXPIRED" },
    });
  });

  it("never publishes a PUBLISHED container twice", async () => {
    const fake = scriptedFetch();
    const { adapter } = adapterWith(fake);
    const context = pendingContext();
    fake.on("GET", containerPath(context), { body: { status: "PUBLISHED" } });
    expect(await adapter.status(context)).toEqual({ state: "published" });
    expect(fake.calls).toHaveLength(1);
  });

  it("refuses a post without a container", async () => {
    const fake = scriptedFetch();
    const { adapter } = adapterWith(fake);
    await expect(adapter.status(fakeContext("threads"))).rejects.toMatchObject({
      error: { code: "permanent", retryable: false },
    });
    expect(fake.calls).toHaveLength(0);
  });
});

describe("threads token errors", () => {
  it("reports an expired token on the quota check as refused credentials", async () => {
    const fake = scriptedFetch();
    const { adapter, refusals } = adapterWith(fake);
    const context = fakeContext("threads");
    fake.on("GET", limitPath(context), {
      status: 401,
      body: graphErrorBody(190, "Error validating access token", 460),
    });
    await expect(adapter.publish(context)).rejects.toMatchObject({
      error: { code: "auth", platformCode: "190/460" },
    });
    expect(refusals).toEqual([
      expect.objectContaining({
        channelId: context.channel.id,
        platform: "threads",
        reason: "token_refused",
        error: expect.objectContaining({ code: "auth", retryable: false }),
      }),
    ]);
    expect(fake.calls).toHaveLength(1);
  });

  it("reports a revoked permission on threads_publish as refused credentials", async () => {
    const fake = scriptedFetch();
    const { adapter, refusals } = adapterWith(fake);
    const context = fakeContext("threads", { externalContainerId: fakeId() });
    fake
      .on("GET", `${V}/${context.post.externalContainerId}`, { body: { status: "FINISHED" } })
      .on("POST", publishPath(context), {
        status: 403,
        body: graphErrorBody(10, "Application does not have permission"),
      });
    await expect(adapter.status(context)).rejects.toMatchObject({
      error: { code: "permission" },
    });
    expect(refusals.map((refusal) => refusal.reason)).toEqual(["token_refused"]);
  });

  it("reports credentials that cannot be decrypted", async () => {
    const fake = scriptedFetch();
    const { adapter, refusals } = adapterWith(fake);
    await expect(
      adapter.publish(fakeContext("threads", { unreadableSecrets: true })),
    ).rejects.toMatchObject({ error: { code: "auth" } });
    expect(refusals.map((refusal) => refusal.reason)).toEqual(["unreadable_credentials"]);
    expect(fake.calls).toHaveLength(0);
  });
});

describe("threads needs_reauth", () => {
  let h: PipelineHarness;
  const keyring = testKeyring();

  beforeAll(async () => {
    h = await createPipelineHarness();
  });

  afterAll(async () => {
    await h.close();
  });

  it("flags the channel needs_reauth through the channels module", async () => {
    const channel = await insertChannel(h.db, keyring, {
      platform: "threads",
      connected: true,
      status: "active",
      dryRun: false,
    });
    const fake = scriptedFetch();
    // Wired as the publisher module wires it.
    const { adapter } = adapterWith(fake, {
      onCredentialsRefused: async ({ channelId, error, reason }) => {
        await flagNeedsReauth(h.deps, h.deps.logger, { channelId, error, reason });
      },
    });
    const base = fakeContext("threads");
    const context: FakeContext = { ...base, channel: { ...base.channel, id: channel.id } };
    fake.on("GET", limitPath(context), {
      status: 401,
      body: graphErrorBody(190, "Error validating access token"),
    });
    await expect(adapter.publish(context)).rejects.toMatchObject({ error: { code: "auth" } });

    const [row] = await h.db.select().from(channels).where(eq(channels.id, channel.id));
    expect(row?.status).toBe("needs_reauth");
    expect(row?.lastError).toMatchObject({ code: "auth", retryable: false });
  });
});
