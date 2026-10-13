import { channels } from "@loomcast/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { flagNeedsReauth } from "../src/modules/channels/reauth";
import { FACEBOOK_REELS_LIMITS, PublishFailure } from "../src/modules/publisher";
import {
  type CredentialsRefusal,
  createFacebookAdapter,
  type MetaAdapterOptions,
} from "../src/modules/publisher/adapters/facebook";
import {
  dryRunParity,
  type FakeContext,
  fakeContext,
  graphErrorBody,
  RUPLOAD_ORIGIN,
  scriptedFetch,
  testPlatforms,
} from "./meta-publisher-support";
import { fakeId, GRAPH_VERSION } from "./oauth-support";
import { createPipelineHarness, type PipelineHarness } from "./pipeline-support";
import { insertChannel, testKeyring } from "./publisher-support";

// Facebook Page Reels: every Graph API and upload host call is answered by a scripted fetch.

const V = `/${GRAPH_VERSION}`;

function adapterWith(
  fake: ReturnType<typeof scriptedFetch>,
  overrides: Partial<MetaAdapterOptions> = {},
) {
  const refusals: CredentialsRefusal[] = [];
  const adapter = createFacebookAdapter({
    platforms: testPlatforms(),
    fetch: fake.fetch,
    sleep: async () => {},
    ruploadBaseUrl: RUPLOAD_ORIGIN,
    onCredentialsRefused: async (refusal) => {
      refusals.push(refusal);
    },
    ...overrides,
  });
  return { adapter, refusals };
}

const reelsPath = (context: FakeContext) => `${V}/${context.request.externalId}/video_reels`;
const uploadPath = (videoId: string) => `/video-upload/${GRAPH_VERSION}/${videoId}`;

/** Scripts a successful start, upload and finish for `videoId`. */
function scriptUpload(
  fake: ReturnType<typeof scriptedFetch>,
  context: FakeContext,
  videoId: string,
) {
  fake
    .on("POST", reelsPath(context), {
      body: { video_id: videoId, upload_url: `${RUPLOAD_ORIGIN}/${videoId}` },
    })
    .on("POST", uploadPath(videoId), { body: { success: true } })
    .on("POST", reelsPath(context), { body: { success: true } });
}

function phases(processing: string, publishing: string, publishStatus?: string) {
  return {
    video_status: processing === "complete" ? "ready" : "processing",
    uploading_phase: { status: "complete" },
    processing_phase: { status: processing },
    publishing_phase: {
      status: publishing,
      ...(publishStatus === undefined ? {} : { publish_status: publishStatus }),
    },
  };
}

describe("facebook validation", () => {
  it("checks the confirmed Page Reels limits without calling the platform", async () => {
    const fake = scriptedFetch();
    const { adapter } = adapterWith(fake);
    expect(FACEBOOK_REELS_LIMITS).toMatchObject({
      minDurationMs: 3_000,
      maxDurationMs: 90_000,
      minWidth: 540,
      minHeight: 960,
    });
    expect(await adapter.validate(fakeContext("facebook"))).toEqual([]);

    const long = await adapter.validate(fakeContext("facebook", { durationMs: 120_000 }));
    expect(long.map((issue) => issue.field)).toContain("duration");
    const short = await adapter.validate(fakeContext("facebook", { durationMs: 2_000 }));
    expect(short.map((issue) => issue.field)).toContain("duration");
    const landscape = await adapter.validate(
      fakeContext("facebook", { width: 1_920, height: 1_080 }),
    );
    expect(landscape.length).toBeGreaterThan(0);
    const small = await adapter.validate(fakeContext("facebook", { width: 360, height: 640 }));
    expect(small.map((issue) => issue.field)).toContain("dimensions");
    expect(fake.calls).toHaveLength(0);
  });
});

describe("facebook publish", () => {
  it("starts, uploads from the public url and finishes the Reel", async () => {
    const fake = scriptedFetch();
    const { adapter, refusals } = adapterWith(fake);
    const context = fakeContext("facebook");
    const videoId = fakeId();
    scriptUpload(fake, context, videoId);

    const result = await adapter.publish(context);
    expect(result).toEqual({ pending: true, containerId: videoId, externalId: videoId });
    expect(fake.pending()).toEqual([]);

    const [start, upload, finish] = fake.calls;
    expect(start?.form.get("upload_phase")).toBe("start");
    expect(start?.headers.get("authorization")).toBe(`Bearer ${context.token}`);
    expect(start?.url.searchParams.get("appsecret_proof")).toMatch(/^[0-9a-f]{64}$/);

    expect(`${upload?.url.origin}${upload?.url.pathname}`).toBe(
      `${RUPLOAD_ORIGIN}/${GRAPH_VERSION}/${videoId}`,
    );
    expect(upload?.headers.get("authorization")).toBe(`OAuth ${context.token}`);
    expect(upload?.headers.get("file_url")).toBe(context.request.videoUrl);

    expect(Object.fromEntries(finish?.form ?? [])).toEqual({
      upload_phase: "finish",
      video_id: videoId,
      video_state: "PUBLISHED",
      description: context.request.caption,
    });
    expect(context.recorded.response).toEqual({
      video_id: videoId,
      upload: "complete",
      finish: "accepted",
    });
    expect(refusals).toEqual([]);
  });

  it("records the same plan as the dry-run adapter", async () => {
    const fake = scriptedFetch();
    const { adapter } = adapterWith(fake);
    const context = fakeContext("facebook");
    scriptUpload(fake, context, fakeId());
    await adapter.publish(context);

    const { dryRun, live } = await dryRunParity(context);
    expect(live).toBeDefined();
    expect(live).toEqual(dryRun);
    expect(JSON.stringify(live)).not.toContain(context.token);
  });

  it("accepts a finish lost in transit when the publishing phase started", async () => {
    const fake = scriptedFetch();
    const { adapter } = adapterWith(fake);
    const context = fakeContext("facebook");
    const videoId = fakeId();
    fake
      .on("POST", reelsPath(context), { body: { video_id: videoId } })
      .on("POST", uploadPath(videoId), { body: { success: true } })
      .on("POST", reelsPath(context), { status: 503, body: { error: { code: 2 } } })
      .on("GET", `${V}/${videoId}`, {
        body: { id: videoId, status: phases("complete", "in_progress") },
      });

    expect(await adapter.publish(context)).toMatchObject({ pending: true, containerId: videoId });
  });

  it("fails a lost finish as transient when the Reel did not start publishing", async () => {
    const fake = scriptedFetch();
    const { adapter } = adapterWith(fake);
    const context = fakeContext("facebook");
    const videoId = fakeId();
    fake
      .on("POST", reelsPath(context), { body: { video_id: videoId } })
      .on("POST", uploadPath(videoId), { body: { success: true } })
      .on("POST", reelsPath(context), { status: 503, body: { error: { code: 2 } } })
      .on("GET", `${V}/${videoId}`, {
        body: { id: videoId, status: phases("complete", "not_started") },
      });

    await expect(adapter.publish(context)).rejects.toMatchObject({
      error: { code: "transient", retryable: true },
    });
  });

  it("maps a refused video on the upload host to invalid_media", async () => {
    const fake = scriptedFetch();
    const { adapter, refusals } = adapterWith(fake);
    const context = fakeContext("facebook");
    const videoId = fakeId();
    fake
      .on("POST", reelsPath(context), { body: { video_id: videoId } })
      .on("POST", uploadPath(videoId), {
        status: 400,
        body: { debug_info: { retriable: false, type: "BadVideo", message: "Bad video" } },
      });
    await expect(adapter.publish(context)).rejects.toMatchObject({
      error: { code: "invalid_media", retryable: false },
    });
    expect(refusals).toEqual([]);
  });

  it("refuses with not_configured when no Meta app is set, without a call", async () => {
    const fake = scriptedFetch();
    const { adapter } = adapterWith(fake, { platforms: testPlatforms({ metaApp: false }) });
    await expect(adapter.publish(fakeContext("facebook"))).rejects.toMatchObject({
      error: { code: "not_configured", retryable: false },
    });
    expect(fake.calls).toHaveLength(0);
  });

  it("maps throttling to rate_limited", async () => {
    const fake = scriptedFetch();
    const { adapter, refusals } = adapterWith(fake);
    const context = fakeContext("facebook");
    fake.on("POST", reelsPath(context), {
      status: 400,
      body: graphErrorBody(32, "Page request limit reached"),
    });
    await expect(adapter.publish(context)).rejects.toMatchObject({
      error: { code: "rate_limited", retryable: true },
    });
    expect(refusals).toEqual([]);
  });
});

describe("facebook status", () => {
  async function statusOf(video: unknown | ((videoId: string) => unknown)) {
    const fake = scriptedFetch();
    const { adapter } = adapterWith(fake);
    const videoId = fakeId();
    const body = typeof video === "function" ? video(videoId) : video;
    const context = fakeContext("facebook", { externalContainerId: videoId, externalId: videoId });
    fake.on("GET", `${V}/${videoId}`, { body: { id: videoId, ...(body as object) } });
    const result = await adapter.status(context);
    expect(fake.calls[0]?.url.searchParams.get("fields")).toBe("status,permalink_url");
    return { result, videoId };
  }

  it("stays pending while the Reel processes", async () => {
    const { result } = await statusOf({ status: phases("in_progress", "not_started") });
    expect(result).toEqual({ state: "pending" });
  });

  it("reports the published Reel with its permalink", async () => {
    const { result, videoId } = await statusOf((id: string) => ({
      permalink_url: `/reel/${id}/`,
      status: phases("complete", "complete", "published"),
    }));
    expect(result).toEqual({
      state: "published",
      externalId: videoId,
      permalink: `https://www.facebook.com/reel/${videoId}/`,
    });
  });

  it("fails a Reel whose processing failed as invalid_media", async () => {
    const { result } = await statusOf({
      status: {
        video_status: "error",
        uploading_phase: { status: "complete" },
        processing_phase: { status: "error", errors: [{ message: "Video too short" }] },
      },
    });
    expect(result).toMatchObject({
      state: "failed",
      error: { code: "invalid_media", retryable: false, message: "Video too short" },
    });
  });

  it("fails a Reel whose publishing failed as permanent", async () => {
    const { result } = await statusOf({ status: phases("complete", "error") });
    expect(result).toMatchObject({ state: "failed", error: { code: "permanent" } });
  });

  it("refuses a post without an uploaded video", async () => {
    const fake = scriptedFetch();
    const { adapter } = adapterWith(fake);
    await expect(adapter.status(fakeContext("facebook"))).rejects.toBeInstanceOf(PublishFailure);
    expect(fake.calls).toHaveLength(0);
  });
});

describe("facebook token errors", () => {
  it("reports an expired token on publish as refused credentials", async () => {
    const fake = scriptedFetch();
    const { adapter, refusals } = adapterWith(fake);
    const context = fakeContext("facebook");
    fake.on("POST", reelsPath(context), {
      status: 401,
      body: graphErrorBody(190, "Error validating access token", 463),
    });
    await expect(adapter.publish(context)).rejects.toMatchObject({
      error: { code: "auth", platformCode: "190/463" },
    });
    expect(refusals).toEqual([
      expect.objectContaining({
        channelId: context.channel.id,
        platform: "facebook",
        reason: "token_refused",
        error: expect.objectContaining({ code: "auth", retryable: false }),
      }),
    ]);
  });

  it("reports a missing permission while polling as refused credentials", async () => {
    const fake = scriptedFetch();
    const { adapter, refusals } = adapterWith(fake);
    const videoId = fakeId();
    const context = fakeContext("facebook", { externalContainerId: videoId });
    fake.on("GET", `${V}/${videoId}`, {
      status: 403,
      body: graphErrorBody(200, "Permissions error"),
    });
    await expect(adapter.status(context)).rejects.toMatchObject({ error: { code: "permission" } });
    expect(refusals.map((refusal) => refusal.reason)).toEqual(["token_refused"]);
  });

  it("reports a token the upload host refuses", async () => {
    const fake = scriptedFetch();
    const { adapter, refusals } = adapterWith(fake);
    const context = fakeContext("facebook");
    const videoId = fakeId();
    fake
      .on("POST", reelsPath(context), { body: { video_id: videoId } })
      .on("POST", uploadPath(videoId), {
        status: 401,
        body: { debug_info: { retriable: false, type: "AuthError", message: "Invalid token" } },
      });
    await expect(adapter.publish(context)).rejects.toMatchObject({ error: { code: "auth" } });
    expect(refusals.map((refusal) => refusal.reason)).toEqual(["token_refused"]);
  });

  it("reports credentials that cannot be decrypted", async () => {
    const fake = scriptedFetch();
    const { adapter, refusals } = adapterWith(fake);
    await expect(
      adapter.publish(fakeContext("facebook", { unreadableSecrets: true })),
    ).rejects.toMatchObject({ error: { code: "auth" } });
    expect(refusals.map((refusal) => refusal.reason)).toEqual(["unreadable_credentials"]);
    expect(fake.calls).toHaveLength(0);
  });

  it("keeps the failure when reporting the refusal throws", async () => {
    const fake = scriptedFetch();
    const onCredentialsRefused = vi.fn(async () => {
      throw new Error("database down");
    });
    const { adapter } = adapterWith(fake, { onCredentialsRefused });
    const context = fakeContext("facebook");
    fake.on("POST", reelsPath(context), {
      status: 401,
      body: graphErrorBody(190, "Error validating access token"),
    });
    await expect(adapter.publish(context)).rejects.toMatchObject({ error: { code: "auth" } });
    expect(onCredentialsRefused).toHaveBeenCalledTimes(1);
  });
});

describe("facebook needs_reauth", () => {
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
      platform: "facebook",
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
    const base = fakeContext("facebook");
    const context: FakeContext = { ...base, channel: { ...base.channel, id: channel.id } };
    fake.on("POST", reelsPath(context), {
      status: 401,
      body: graphErrorBody(190, "Error validating access token"),
    });
    await expect(adapter.publish(context)).rejects.toMatchObject({ error: { code: "auth" } });

    const [row] = await h.db.select().from(channels).where(eq(channels.id, channel.id));
    expect(row?.status).toBe("needs_reauth");
    expect(row?.lastError).toMatchObject({ code: "auth", retryable: false });
  });
});
