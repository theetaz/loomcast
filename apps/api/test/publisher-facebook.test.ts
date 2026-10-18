import { randomUUID } from "node:crypto";
import type {
  PostFormat,
  PostOptions,
  PublishMediaItem,
  PublishRequest,
  VideoPublishRequest,
} from "@loomcast/contracts";
import { channels } from "@loomcast/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { flagNeedsReauth } from "../src/modules/channels/reauth";
import { FACEBOOK_REELS_LIMITS, PublishFailure } from "../src/modules/publisher";
import {
  type CredentialsRefusal,
  createFacebookAdapter,
  findSentPost,
  graphTimeMs,
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

// Every other Facebook format: a fake context per format, built on `fakeContext`.

interface FormatOptions {
  items?: Partial<PublishMediaItem>[];
  caption?: string;
  options?: PostOptions;
  externalContainerId?: string | null;
  externalId?: string | null;
}

interface FormatContext extends Omit<FakeContext, "request"> {
  readonly request: PublishRequest;
}

function facebookFormatContext(format: PostFormat, settings: FormatOptions = {}): FormatContext {
  const base = fakeContext("facebook", {
    ...(settings.externalContainerId === undefined
      ? {}
      : { externalContainerId: settings.externalContainerId }),
    ...(settings.externalId === undefined ? {} : { externalId: settings.externalId }),
  });
  const caption = settings.caption ?? base.request.caption;
  const options = settings.options ?? {};
  const items: PublishMediaItem[] = (settings.items ?? [{}]).map((item, index) => {
    const type = item.type ?? "image";
    return {
      type,
      url: `https://media.example.test/p/${base.post.id}/${index}.${type === "image" ? "jpg" : "mp4"}`,
      mime: type === "image" ? "image/jpeg" : "video/mp4",
      bytes: type === "image" ? 1_048_576 : 9 * 1_048_576,
      width: 1_080,
      height: type === "image" ? 1_350 : 1_920,
      durationMs: type === "image" ? null : 20_000,
      ...item,
    };
  });
  const common = {
    platform: "facebook" as const,
    externalId: base.request.externalId,
    caption,
    ...(Object.keys(options).length === 0 ? {} : { options }),
  };
  let request: PublishRequest;
  switch (format) {
    case "reel":
    case "video":
      request = { ...base.request, ...common, format };
      break;
    case "image":
    case "carousel":
    case "story":
      request = { ...common, format, media: items };
      break;
    case "text":
      request = { ...common, format: "text" };
      break;
  }
  const video = format === "reel" || format === "video";
  return {
    ...base,
    request,
    post: { ...base.post, options },
    media: {
      format,
      video: video ? base.media.video : null,
      items: video
        ? []
        : format === "text"
          ? []
          : items.map((item) => ({
              type: item.type,
              assetId: randomUUID(),
              sha256: "1".repeat(64),
              bytes: item.bytes,
              mime: item.mime,
              durationMs: item.durationMs,
              width: item.width,
              height: item.height,
              ...(item.altText === undefined ? {} : { altText: item.altText }),
            })),
      posterAssetId: null,
    },
    async getPublicItemUrls() {
      return items.map((item) => item.url);
    },
    async publishRequest() {
      return request;
    },
  };
}

const asFake = (context: FormatContext) => context as unknown as FakeContext;
const pagePath = (context: FormatContext, edge: string) =>
  `${V}/${context.request.externalId}/${edge}`;
const graphTime = (date: Date) => date.toISOString().replace(/\.\d{3}Z$/, "+0000");

/** The live adapter recorded the plan the dry-run adapter records, without the token. */
async function expectParity(context: FormatContext): Promise<void> {
  const { dryRun, live } = await dryRunParity(asFake(context));
  expect(live).toBeDefined();
  expect(live).toEqual(dryRun);
  expect(JSON.stringify(live)).not.toContain(context.token);
}

describe("facebook videos", () => {
  it("posts the public video with its description and title, then waits", async () => {
    const fake = scriptedFetch();
    const { adapter } = adapterWith(fake);
    const context = facebookFormatContext("video", {
      options: { facebook: { title: "Ownership" } },
    });
    const videoId = fakeId();
    fake.on("POST", pagePath(context, "videos"), { body: { id: videoId } });

    expect(await adapter.publish(asFake(context))).toEqual({
      pending: true,
      containerId: videoId,
      externalId: videoId,
    });
    expect(Object.fromEntries(fake.calls[0]?.form ?? [])).toEqual({
      file_url: (context.request as VideoPublishRequest).videoUrl,
      description: context.request.caption,
      title: "Ownership",
    });
    await expectParity(context);
  });

  it("does not retry an upload lost in transit, which cannot be checked", async () => {
    const fake = scriptedFetch();
    const { adapter } = adapterWith(fake);
    const context = facebookFormatContext("video");
    fake.on("POST", pagePath(context, "videos"), { status: 503, body: { error: { code: 2 } } });
    await expect(adapter.publish(asFake(context))).rejects.toMatchObject({
      error: {
        code: "transient",
        retryable: false,
        message: expect.stringContaining("check the Page"),
      },
    });
    expect(fake.calls).toHaveLength(1);
  });

  it("reads the video's status with a /watch permalink when none is given", async () => {
    const fake = scriptedFetch();
    const { adapter } = adapterWith(fake);
    const videoId = fakeId();
    const context = facebookFormatContext("video", {
      externalContainerId: videoId,
      externalId: videoId,
    });
    fake.on("GET", `${V}/${videoId}`, {
      body: { id: videoId, status: phases("complete", "complete", "published") },
    });
    expect(await adapter.status(asFake(context))).toEqual({
      state: "published",
      externalId: videoId,
      permalink: `https://www.facebook.com/watch/?v=${videoId}`,
    });
  });

  it("fails a video kept as a draft", async () => {
    const fake = scriptedFetch();
    const { adapter } = adapterWith(fake);
    const videoId = fakeId();
    const context = facebookFormatContext("video", { externalContainerId: videoId });
    fake.on("GET", `${V}/${videoId}`, {
      body: { id: videoId, status: phases("complete", "complete", "draft") },
    });
    expect(await adapter.status(asFake(context))).toMatchObject({
      state: "failed",
      error: { code: "permanent", message: expect.stringContaining("video as a draft") },
    });
  });
});

describe("facebook photos", () => {
  it("publishes the photo with its caption and alt text and reads its permalink", async () => {
    const fake = scriptedFetch();
    const { adapter } = adapterWith(fake);
    const context = facebookFormatContext("image", { items: [{ altText: "A crab" }] });
    const photoId = fakeId();
    const postId = `${context.request.externalId}_${fakeId()}`;
    fake
      .on("POST", pagePath(context, "photos"), { body: { id: photoId, post_id: postId } })
      .on("GET", `${V}/${postId}`, {
        body: { id: postId, permalink_url: `https://www.facebook.com/page/posts/${postId}` },
      });

    expect(await adapter.publish(asFake(context))).toEqual({
      pending: false,
      containerId: photoId,
      externalId: postId,
      permalink: `https://www.facebook.com/page/posts/${postId}`,
    });
    const [upload, permalink] = fake.calls;
    expect(Object.fromEntries(upload?.form ?? [])).toEqual({
      url: `https://media.example.test/p/${context.post.id}/0.jpg`,
      caption: context.request.caption,
      alt_text_custom: "A crab",
    });
    expect(permalink?.url.searchParams.get("fields")).toBe("permalink_url");
    await expectParity(context);
  });

  it("keeps a published photo when its permalink cannot be read", async () => {
    const fake = scriptedFetch();
    const { adapter } = adapterWith(fake);
    const context = facebookFormatContext("image");
    const postId = fakeId();
    fake
      .on("POST", pagePath(context, "photos"), { body: { id: fakeId(), post_id: postId } })
      .on("GET", `${V}/${postId}`, { status: 500, body: { error: { code: 1 } } })
      .on("GET", `${V}/${postId}`, { status: 500, body: { error: { code: 1 } } })
      .on("GET", `${V}/${postId}`, { status: 500, body: { error: { code: 1 } } });
    expect(await adapter.publish(asFake(context))).toMatchObject({
      pending: false,
      externalId: postId,
      permalink: `https://www.facebook.com/${postId}`,
    });
  });

  it("takes a photo post lost in transit from the Page's feed instead of posting twice", async () => {
    const fake = scriptedFetch();
    const { adapter } = adapterWith(fake);
    const context = facebookFormatContext("image");
    const postId = fakeId();
    fake
      .on("POST", pagePath(context, "photos"), { status: 503, body: { error: { code: 2 } } })
      .on("GET", pagePath(context, "feed"), {
        body: {
          data: [
            {
              id: postId,
              message: context.request.caption,
              created_time: graphTime(context.post.attemptStartedAt),
              permalink_url: `https://www.facebook.com/${postId}`,
            },
          ],
        },
      });
    expect(await adapter.publish(asFake(context))).toEqual({
      pending: false,
      externalId: postId,
      permalink: `https://www.facebook.com/${postId}`,
    });
    expect(fake.calls.filter((call) => call.method === "POST")).toHaveLength(1);
  });

  it("retries a lost photo post that is not on the Page", async () => {
    const fake = scriptedFetch();
    const { adapter } = adapterWith(fake);
    const context = facebookFormatContext("image");
    const earlier = new Date(context.post.attemptStartedAt.getTime() - 60 * 60_000);
    fake
      .on("POST", pagePath(context, "photos"), { status: 503, body: { error: { code: 2 } } })
      .on("GET", pagePath(context, "feed"), {
        body: {
          data: [
            { id: fakeId(), message: context.request.caption, created_time: graphTime(earlier) },
          ],
        },
      });
    await expect(adapter.publish(asFake(context))).rejects.toMatchObject({
      error: { code: "transient", retryable: true },
    });
  });

  it("does not retry a lost photo post without a caption, which cannot be recognised", async () => {
    const fake = scriptedFetch();
    const { adapter } = adapterWith(fake);
    const context = facebookFormatContext("image", { caption: "" });
    fake.on("POST", pagePath(context, "photos"), { status: 503, body: { error: { code: 2 } } });
    await expect(adapter.publish(asFake(context))).rejects.toMatchObject({
      error: { code: "transient", retryable: false },
    });
    expect(fake.calls).toHaveLength(1);
  });

  it("maps an image the platform cannot use to invalid_media", async () => {
    const fake = scriptedFetch();
    const { adapter } = adapterWith(fake);
    const context = facebookFormatContext("image");
    fake.on("POST", pagePath(context, "photos"), {
      status: 400,
      body: graphErrorBody(324, "Missing or invalid image file"),
    });
    await expect(adapter.publish(asFake(context))).rejects.toMatchObject({
      error: { code: "invalid_media", retryable: false, platformCode: "324" },
    });
  });

  it("refuses WebP photos before anything is sent", async () => {
    const fake = scriptedFetch();
    const { adapter } = adapterWith(fake);
    const context = facebookFormatContext("image", { items: [{ mime: "image/webp" }] });
    expect((await adapter.validate(asFake(context))).map((issue) => issue.field)).toEqual([
      "media.0",
    ]);
    expect(fake.calls).toHaveLength(0);
  });
});

describe("facebook multi-photo posts", () => {
  it("uploads the photos unpublished, then posts them together", async () => {
    const fake = scriptedFetch();
    const { adapter } = adapterWith(fake);
    const context = facebookFormatContext("carousel", { items: [{}, {}, {}] });
    const photoIds = [fakeId(), fakeId(), fakeId()];
    const postId = fakeId();
    for (const id of photoIds) {
      fake.on("POST", pagePath(context, "photos"), { body: { id } });
    }
    fake
      .on("POST", pagePath(context, "feed"), { body: { id: postId } })
      .on("GET", `${V}/${postId}`, { body: { permalink_url: `/${postId}` } });

    expect(await adapter.publish(asFake(context))).toEqual({
      pending: false,
      externalId: postId,
      permalink: `https://www.facebook.com/${postId}`,
    });
    const uploads = fake.calls.slice(0, 3);
    expect(uploads.map((call) => call.form.get("published"))).toEqual(["false", "false", "false"]);
    expect(uploads.map((call) => call.form.get("caption"))).toEqual([null, null, null]);
    expect(Object.fromEntries(fake.calls[3]?.form ?? [])).toEqual({
      message: context.request.caption,
      "attached_media[0]": JSON.stringify({ media_fbid: photoIds[0] }),
      "attached_media[1]": JSON.stringify({ media_fbid: photoIds[1] }),
      "attached_media[2]": JSON.stringify({ media_fbid: photoIds[2] }),
    });
    expect(context.recorded.response).toEqual({ photo_ids: photoIds, post_id: postId });
    await expectParity(context);
  });

  it("stops before posting when a photo upload fails", async () => {
    const fake = scriptedFetch();
    const { adapter } = adapterWith(fake);
    const context = facebookFormatContext("carousel", { items: [{}, {}] });
    fake
      .on("POST", pagePath(context, "photos"), { body: { id: fakeId() } })
      .on("POST", pagePath(context, "photos"), { status: 503, body: { error: { code: 2 } } });
    await expect(adapter.publish(asFake(context))).rejects.toMatchObject({
      error: { code: "transient", retryable: true },
    });
    expect(fake.calls.map((call) => call.url.pathname)).not.toContain(pagePath(context, "feed"));
  });

  it("recognises a lost post by its attached photos", async () => {
    const fake = scriptedFetch();
    const { adapter } = adapterWith(fake);
    const context = facebookFormatContext("carousel", { items: [{}, {}], caption: "" });
    const photoIds = [fakeId(), fakeId()];
    const postId = fakeId();
    fake
      .on("POST", pagePath(context, "photos"), { body: { id: photoIds[0] } })
      .on("POST", pagePath(context, "photos"), { body: { id: photoIds[1] } })
      .on("POST", pagePath(context, "feed"), { status: 504, body: { error: { code: 1 } } })
      .on("GET", pagePath(context, "feed"), {
        body: {
          data: [
            {
              id: postId,
              created_time: graphTime(context.post.attemptStartedAt),
              attachments: {
                data: [{ subattachments: { data: photoIds.map((id) => ({ target: { id } })) } }],
              },
            },
          ],
        },
      });
    expect(await adapter.publish(asFake(context))).toMatchObject({
      pending: false,
      externalId: postId,
    });
    expect(fake.pending()).toEqual([]);
  });

  it("refuses a video among the photos", async () => {
    const fake = scriptedFetch();
    const { adapter } = adapterWith(fake);
    const context = facebookFormatContext("carousel", { items: [{}, { type: "video" }] });
    expect(await adapter.validate(asFake(context))).toEqual([
      { field: "media", message: expect.stringContaining("photos only") },
    ]);
  });
});

describe("facebook text posts", () => {
  it("posts the message and link and reads the permalink", async () => {
    const fake = scriptedFetch();
    const { adapter } = adapterWith(fake);
    const context = facebookFormatContext("text", {
      options: { facebook: { link: "https://example.test/write-up" } },
    });
    const postId = fakeId();
    fake
      .on("POST", pagePath(context, "feed"), { body: { id: postId } })
      .on("GET", `${V}/${postId}`, {
        body: { permalink_url: `https://www.facebook.com/${postId}` },
      });
    expect(await adapter.publish(asFake(context))).toEqual({
      pending: false,
      externalId: postId,
      permalink: `https://www.facebook.com/${postId}`,
    });
    expect(Object.fromEntries(fake.calls[0]?.form ?? [])).toEqual({
      message: context.request.caption,
      link: "https://example.test/write-up",
    });
    await expectParity(context);
  });

  it("refuses a text post with neither a caption nor a link", async () => {
    const { adapter } = adapterWith(scriptedFetch());
    const issues = await adapter.validate(asFake(facebookFormatContext("text", { caption: "" })));
    expect(issues.map((issue) => issue.field)).toEqual(["caption"]);
  });

  it("does not retry a lost link post without a message", async () => {
    const fake = scriptedFetch();
    const { adapter } = adapterWith(fake);
    const context = facebookFormatContext("text", {
      caption: "",
      options: { facebook: { link: "https://example.test/write-up" } },
    });
    fake.on("POST", pagePath(context, "feed"), { status: 503, body: { error: { code: 2 } } });
    await expect(adapter.publish(asFake(context))).rejects.toMatchObject({
      error: { code: "transient", retryable: false },
    });
  });

  it("reports a post the platform refuses as permanent, without a lookup", async () => {
    const fake = scriptedFetch();
    const { adapter } = adapterWith(fake);
    const context = facebookFormatContext("text");
    fake.on("POST", pagePath(context, "feed"), {
      status: 400,
      body: graphErrorBody(368, "The action attempted has been deemed abusive"),
    });
    await expect(adapter.publish(asFake(context))).rejects.toMatchObject({
      error: { code: "permanent", retryable: false },
    });
    expect(fake.calls).toHaveLength(1);
  });

  it("reports a published text post on a status check without a call", async () => {
    const fake = scriptedFetch();
    const { adapter } = adapterWith(fake);
    const postId = fakeId();
    const context = facebookFormatContext("text", { externalId: postId });
    expect(await adapter.status(asFake(context))).toEqual({
      state: "published",
      externalId: postId,
      permalink: `https://www.facebook.com/${postId}`,
    });
    expect(fake.calls).toHaveLength(0);
  });
});

describe("facebook stories", () => {
  it("publishes a photo story from an unpublished photo and reads its url", async () => {
    const fake = scriptedFetch();
    const { adapter } = adapterWith(fake);
    const context = facebookFormatContext("story");
    const photoId = fakeId();
    const postId = fakeId();
    fake
      .on("POST", pagePath(context, "photos"), { body: { id: photoId } })
      .on("POST", pagePath(context, "photo_stories"), { body: { success: true, post_id: postId } })
      .on("GET", pagePath(context, "stories"), {
        body: {
          data: [
            { post_id: postId, url: `https://facebook.com/stories/${postId}`, media_type: "photo" },
          ],
        },
      });
    expect(await adapter.publish(asFake(context))).toEqual({
      pending: false,
      containerId: photoId,
      externalId: postId,
      permalink: `https://facebook.com/stories/${postId}`,
    });
    expect(fake.calls[0]?.form.get("published")).toBe("false");
    expect(Object.fromEntries(fake.calls[1]?.form ?? [])).toEqual({ photo_id: photoId });
    await expectParity(context);
  });

  it("takes a photo story lost in transit from the Page's stories", async () => {
    const fake = scriptedFetch();
    const { adapter } = adapterWith(fake);
    const context = facebookFormatContext("story");
    const postId = fakeId();
    fake
      .on("POST", pagePath(context, "photos"), { body: { id: fakeId() } })
      .on("POST", pagePath(context, "photo_stories"), { status: 503, body: { error: { code: 2 } } })
      .on("GET", pagePath(context, "stories"), {
        body: {
          data: [
            {
              post_id: postId,
              media_type: "photo",
              status: "PUBLISHED",
              creation_time: Math.floor(context.post.attemptStartedAt.getTime() / 1_000),
            },
          ],
        },
      });
    expect(await adapter.publish(asFake(context))).toMatchObject({
      pending: false,
      externalId: postId,
      permalink: `https://www.facebook.com/${postId}`,
    });
  });

  it("uploads a video story like a Reel and waits for it", async () => {
    const fake = scriptedFetch();
    const { adapter } = adapterWith(fake);
    const context = facebookFormatContext("story", { items: [{ type: "video" }] });
    const videoId = fakeId();
    const postId = fakeId();
    fake
      .on("POST", pagePath(context, "video_stories"), { body: { video_id: videoId } })
      .on("POST", uploadPath(videoId), { body: { success: true } })
      .on("POST", pagePath(context, "video_stories"), { body: { success: true, post_id: postId } });
    expect(await adapter.publish(asFake(context))).toEqual({
      pending: true,
      containerId: videoId,
      externalId: postId,
    });
    const [start, upload, finish] = fake.calls;
    expect(start?.form.get("upload_phase")).toBe("start");
    expect(upload?.headers.get("file_url")).toBe(
      `https://media.example.test/p/${context.post.id}/0.mp4`,
    );
    expect(Object.fromEntries(finish?.form ?? [])).toEqual({
      upload_phase: "finish",
      video_id: videoId,
    });
    await expectParity(context);
  });

  it("accepts a video story finish lost in transit when publishing started", async () => {
    const fake = scriptedFetch();
    const { adapter } = adapterWith(fake);
    const context = facebookFormatContext("story", { items: [{ type: "video" }] });
    const videoId = fakeId();
    fake
      .on("POST", pagePath(context, "video_stories"), { body: { video_id: videoId } })
      .on("POST", uploadPath(videoId), { body: { success: true } })
      .on("POST", pagePath(context, "video_stories"), { status: 503, body: { error: { code: 2 } } })
      .on("GET", `${V}/${videoId}`, {
        body: { id: videoId, status: phases("complete", "in_progress") },
      });
    expect(await adapter.publish(asFake(context))).toEqual({
      pending: true,
      containerId: videoId,
      externalId: videoId,
    });
  });

  it("reports a published video story with its story url, keeping the story post id", async () => {
    const fake = scriptedFetch();
    const { adapter } = adapterWith(fake);
    const videoId = fakeId();
    const postId = fakeId();
    const context = facebookFormatContext("story", {
      items: [{ type: "video" }],
      externalContainerId: videoId,
      externalId: postId,
    });
    fake
      .on("GET", `${V}/${videoId}`, {
        body: { id: videoId, status: phases("complete", "complete", "published") },
      })
      .on("GET", pagePath(context, "stories"), {
        body: { data: [{ post_id: postId, url: `https://facebook.com/stories/${postId}` }] },
      });
    expect(await adapter.status(asFake(context))).toEqual({
      state: "published",
      permalink: `https://facebook.com/stories/${postId}`,
    });
  });

  it("fails a video story the platform could not process", async () => {
    const fake = scriptedFetch();
    const { adapter } = adapterWith(fake);
    const videoId = fakeId();
    const context = facebookFormatContext("story", {
      items: [{ type: "video" }],
      externalContainerId: videoId,
    });
    fake.on("GET", `${V}/${videoId}`, {
      body: {
        id: videoId,
        status: {
          video_status: "error",
          uploading_phase: { status: "complete" },
          processing_phase: { status: "error", error: { message: "Unsupported codec" } },
        },
      },
    });
    expect(await adapter.status(asFake(context))).toMatchObject({
      state: "failed",
      error: { code: "invalid_media", retryable: false, message: "Unsupported codec" },
    });
  });

  it("refuses a video story longer than 60 seconds", async () => {
    const { adapter } = adapterWith(scriptedFetch());
    const context = facebookFormatContext("story", {
      items: [{ type: "video", durationMs: 75_000 }],
    });
    expect((await adapter.validate(asFake(context))).map((issue) => issue.field)).toEqual([
      "duration",
    ]);
  });
});

describe("facebook recovery matching", () => {
  const since = new Date("2026-10-18T10:00:00Z");

  it("reads Graph times and UNIX seconds", () => {
    expect(graphTimeMs("2026-10-18T10:00:00+0000")).toBe(since.getTime());
    expect(graphTimeMs(since.getTime() / 1_000)).toBe(since.getTime());
    expect(graphTimeMs(String(since.getTime() / 1_000))).toBe(since.getTime());
    expect(graphTimeMs("not a time")).toBeNull();
  });

  it("matches the sent message or photos only on posts made since the attempt", () => {
    const feed = {
      data: [
        { id: "old", message: "Hello", created_time: "2026-10-18T09:00:00+0000" },
        { id: "other", message: "Something else", created_time: "2026-10-18T10:01:00+0000" },
        { id: "new", message: " Hello ", created_time: "2026-10-18T10:01:00+0000" },
      ],
    };
    expect(findSentPost(feed, { message: "Hello" }, since)?.id).toBe("new");
    expect(findSentPost(feed, { message: "" }, since)).toBeNull();
    expect(findSentPost({ data: [feed.data[0] as never] }, { message: "Hello" }, since)).toBeNull();
  });
});

describe("facebook best-effort reads", () => {
  it("does not flag the channel when the recovery lookup is refused", async () => {
    const fake = scriptedFetch();
    const { adapter, refusals } = adapterWith(fake);
    const context = facebookFormatContext("text");
    fake
      .on("POST", pagePath(context, "feed"), { status: 503, body: { error: { code: 2 } } })
      .on("GET", pagePath(context, "feed"), {
        status: 403,
        body: graphErrorBody(10, "Requires pages_read_user_content"),
      });
    await expect(adapter.publish(asFake(context))).rejects.toMatchObject({
      error: { code: "transient", retryable: true },
    });
    expect(refusals).toEqual([]);
  });
});
