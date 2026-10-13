import { randomBytes, randomUUID } from "node:crypto";
import type { JsonObject, PublishRequest } from "@loomcast/contracts";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "../src/lib/logger";
import {
  appSecretProof,
  createMetaGraphClient,
  type GraphClientOptions,
} from "../src/lib/meta-graph";
import {
  buildCaption,
  type CaptionParts,
  createDryRunAdapter,
  type PublishContext,
  PublishFailure,
  type PublishMedia,
  type PublishPost,
  redactRequest,
} from "../src/modules/publisher";
import {
  createInstagramAdapter,
  graphClientFromEnv,
  INSTAGRAM_QUOTA_RETRY_MS,
  parseQuota,
} from "../src/modules/publisher/adapters/instagram";
import {
  answer,
  fakeCredential,
  fakeId,
  fakeMetaApp,
  formOf,
  GRAPH_ORIGIN,
  GRAPH_VERSION,
  graphError,
  installMockAgent,
  type Reply,
  type SeenRequest,
} from "./oauth-support";

// The Instagram Reels adapter against a mocked Graph API: every call is answered by an undici
// `MockAgent` that refuses anything unexpected, so nothing leaves the process. Tokens, app
// secrets and ids are generated per run.

let mock: ReturnType<typeof installMockAgent>;

beforeAll(() => {
  mock = installMockAgent();
});

afterAll(async () => {
  await mock.restore();
});

afterEach(() => {
  mock.agent.assertNoPendingInterceptors();
});

const app = fakeMetaApp();
const graph = () => mock.agent.get(GRAPH_ORIGIN);
const v = (path: string) => `/${GRAPH_VERSION}${path}`;

function client(options: Partial<GraphClientOptions> = {}) {
  return createMetaGraphClient(
    { metaGraphBaseUrl: GRAPH_ORIGIN, metaGraphVersion: GRAPH_VERSION, meta: app },
    { sleep: async () => {}, random: () => 0.5, ...options },
  );
}

function adapter(options: Partial<GraphClientOptions> = {}) {
  return createInstagramAdapter({ client: client(options) });
}

interface FakeContext {
  context: PublishContext;
  token: string;
  igUserId: string;
  recorded(): { request: JsonObject | null; response: JsonObject | null };
  /** Calls of `secrets` and `getPublicVideoUrl`, to prove `validate` reads neither. */
  calls: { secrets: number; promote: number };
}

interface ContextSpec {
  dryRun?: boolean;
  media?: Partial<PublishMedia>;
  post?: Partial<PublishPost>;
  caption?: CaptionParts;
  igUserId?: string | null;
  videoUrl?: string;
}

/** A publish context like the publisher builds, without a database or object storage. */
function fakeContext(spec: ContextSpec = {}): FakeContext {
  const token = fakeCredential("ig-token");
  const igUserId = spec.igUserId === undefined ? fakeId() : spec.igUserId;
  const sha256 = randomBytes(32).toString("hex");
  const postId = randomUUID();
  const videoUrl = spec.videoUrl ?? `https://media.example.test/p/${randomUUID()}/${sha256}.mp4`;
  const media: PublishMedia = {
    renderAssetId: randomUUID(),
    sha256,
    mime: "video/mp4",
    bytes: 24 * 1_048_576,
    durationMs: 45_000,
    width: 1_080,
    height: 1_920,
    posterAssetId: null,
    probe: { videoCodec: "h264", audioCodec: "aac", fps: 30, sampleRate: 48_000, channels: 2 },
    ...spec.media,
  };
  const post: PublishPost = {
    id: postId,
    itemId: randomUUID(),
    versionId: randomUUID(),
    scheduledAt: new Date(),
    attempt: 1,
    attemptStartedAt: new Date(),
    externalId: null,
    externalContainerId: null,
    ...spec.post,
  };
  const caption = buildCaption(
    "instagram",
    spec.caption ?? { text: "Ownership in sixty seconds", hashtags: ["rust"] },
  );
  let request: JsonObject | null = null;
  let response: JsonObject | null = null;
  const calls = { secrets: 0, promote: 0 };
  const context: PublishContext = {
    platform: "instagram",
    dryRun: spec.dryRun ?? false,
    post,
    channel: {
      id: randomUUID(),
      platform: "instagram",
      displayName: "Loomcast",
      externalId: igUserId,
      username: "loomcast",
      parentChannelId: null,
      scopes: [],
      meta: {},
    },
    media,
    async secrets() {
      calls.secrets += 1;
      return { accessToken: token };
    },
    async getPublicVideoUrl() {
      calls.promote += 1;
      return videoUrl;
    },
    async getPublicPosterUrl() {
      return null;
    },
    caption: () => caption,
    async publishRequest(): Promise<PublishRequest> {
      return {
        platform: "instagram",
        externalId: igUserId ?? "{account-id}",
        videoUrl: await this.getPublicVideoUrl(),
        caption: caption.text,
        durationMs: media.durationMs ?? 0,
        width: media.width ?? 1_080,
        height: media.height ?? 1_920,
      };
    },
    record(part) {
      if (part.request !== undefined) request = redactRequest(part.request);
      if (part.response !== undefined) response = redactRequest(part.response);
    },
    signal: new AbortController().signal,
    logger: createLogger({ level: "silent" }),
    now: () => new Date(),
  };
  return {
    context,
    token,
    igUserId: igUserId ?? "",
    recorded: () => ({ request, response }),
    calls,
  };
}

async function failure(promise: Promise<unknown>): Promise<PublishFailure> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof PublishFailure) return error;
    throw error;
  }
  throw new Error("expected a PublishFailure");
}

const quota = (usage: number, total = 50): Reply => ({
  body: { data: [{ quota_usage: usage, config: { quota_total: total, quota_duration: 86_400 } }] },
});

function answerQuota(igUserId: string, reply: Reply, seen?: SeenRequest[]) {
  answer(graph(), "GET", v(`/${igUserId}/content_publishing_limit`), reply, seen);
}

function answerContainer(igUserId: string, reply: Reply, seen?: SeenRequest[]) {
  answer(graph(), "POST", v(`/${igUserId}/media`), reply, seen);
}

function answerStatus(containerId: string, statusCode: string, status?: string) {
  answer(graph(), "GET", v(`/${containerId}`), {
    body: { id: containerId, status_code: statusCode, ...(status === undefined ? {} : { status }) },
  });
}

function answerPermalink(mediaId: string, seen?: SeenRequest[]) {
  answer(
    graph(),
    "GET",
    v(`/${mediaId}`),
    { body: { id: mediaId, permalink: `https://www.instagram.com/reel/${mediaId}/` } },
    seen,
  );
}

describe("instagram validate", () => {
  it("accepts a 9:16 H.264/AAC reel without reading credentials or copying media", async () => {
    const fake = fakeContext();
    expect(await adapter().validate(fake.context)).toEqual([]);
    expect(fake.calls).toEqual({ secrets: 0, promote: 0 });
  });

  it.each([
    ["duration", { durationMs: 2_000 }],
    ["duration", { durationMs: 15 * 60_000 + 1_000 }],
    ["duration", { durationMs: null }],
    ["size", { bytes: 301 * 1_048_576 }],
    ["dimensions", { width: 2_160, height: 3_840 }],
    ["video", { mime: "video/webm" }],
    ["video", { probe: { videoCodec: "vp9", audioCodec: "aac" } }],
    ["audio", { probe: { videoCodec: "h264", audioCodec: "opus" } }],
    ["audio", { probe: { videoCodec: "h264", sampleRate: 96_000 } }],
    ["video", { probe: { videoCodec: "h264", fps: 120 } }],
    ["video", { probe: { videoCodec: "h264", bitRate: 40_000_000 } }],
  ] as const)("refuses media with a bad %s (%j)", async (field, media) => {
    const fake = fakeContext({ media: media as Partial<PublishMedia> });
    const issues = await adapter().validate(fake.context);
    expect(issues.map((issue) => issue.field)).toContain(field);
  });

  it("accepts HEVC and media without a probe", async () => {
    expect(
      await adapter().validate(fakeContext({ media: { probe: { videoCodec: "hevc" } } }).context),
    ).toEqual([]);
    expect(await adapter().validate(fakeContext({ media: { probe: null } }).context)).toEqual([]);
  });

  it("refuses more than 20 mentions and fits hashtags and length", async () => {
    const mentions = Array.from({ length: 21 }, (_, index) => `@user${index}`).join(" ");
    const many = fakeContext({ caption: { text: mentions } });
    expect(await adapter().validate(many.context)).toEqual([
      { field: "caption", message: "The caption mentions more than 20 accounts." },
    ]);

    const tags = Array.from({ length: 40 }, (_, index) => `tag${index}`);
    const long = fakeContext({ caption: { text: "word ".repeat(600), hashtags: tags } });
    expect(await adapter().validate(long.context)).toEqual([]);
    expect([...long.context.caption().text].length).toBeLessThanOrEqual(2_200);
  });
});

describe("instagram publish", () => {
  it("records what the dry run records, checks the quota and creates a Reels container", async () => {
    const videoUrl = `https://media.example.test/p/${randomUUID()}/render.mp4`;
    const live = fakeContext({ videoUrl });
    const dry = fakeContext({ videoUrl, dryRun: true, igUserId: live.igUserId });
    const containerId = fakeId();
    const seen: SeenRequest[] = [];
    answerQuota(live.igUserId, quota(3), seen);
    answerContainer(live.igUserId, { body: { id: containerId } }, seen);

    const result = await adapter().publish(live.context);
    expect(result).toEqual({ pending: true, containerId });

    await createDryRunAdapter("instagram").publish(dry.context);
    expect(live.recorded().request).toEqual(dry.recorded().request);
    expect(live.recorded().response).toEqual({
      quota_usage: 3,
      quota_total: 50,
      quota_duration: 86_400,
      container_id: containerId,
    });

    const [limit, create] = seen;
    expect(limit?.query.get("fields")).toBe("quota_usage,config");
    expect(limit?.headers.authorization).toBe(`Bearer ${live.token}`);
    expect(limit?.query.get("appsecret_proof")).toBe(appSecretProof(live.token, app.appSecret));
    expect(create?.headers.authorization).toBe(`Bearer ${live.token}`);
    const form = await formOf(create);
    expect(Object.fromEntries(form)).toEqual({
      media_type: "REELS",
      video_url: videoUrl,
      caption: "Ownership in sixty seconds\n\n#rust",
      share_to_feed: "true",
    });
    expect(JSON.stringify(live.recorded())).not.toContain(live.token);
  });

  it("returns rate_limited with retryAfterMs when the quota is used up", async () => {
    const fake = fakeContext();
    answerQuota(fake.igUserId, quota(50));
    const error = await failure(adapter().publish(fake.context));
    expect(error.error).toMatchObject({
      code: "rate_limited",
      retryable: true,
      retryAfterMs: INSTAGRAM_QUOTA_RETRY_MS,
    });
    // No container was created: the mock has no answer for one and refuses unexpected calls.
    // Nor was the render copied to public storage while the post waits out the quota.
    expect(fake.calls.promote).toBe(0);
    expect(fake.recorded().request).toMatchObject({
      platform: "instagram",
      steps: [{ step: "publishing_limit" }],
    });
  });

  it("reads quota answers leniently", () => {
    expect(parseQuota({ data: [{ quota_usage: 4 }] })).toEqual({
      usage: 4,
      total: 50,
      durationSeconds: 86_400,
    });
    expect(parseQuota({ data: [] })).toBeNull();
    expect(parseQuota({ unexpected: true })).toBeNull();
  });

  it("does not create a second container when the earlier one was published", async () => {
    const containerId = fakeId();
    const mediaId = fakeId();
    const fake = fakeContext({ post: { externalContainerId: containerId, externalId: mediaId } });
    answerStatus(containerId, "PUBLISHED");
    answerPermalink(mediaId);
    expect(await adapter().publish(fake.context)).toEqual({
      pending: false,
      externalId: mediaId,
      permalink: `https://www.instagram.com/reel/${mediaId}/`,
      containerId,
    });
    expect(fake.calls.promote).toBe(0);
  });

  it("creates a new container when the earlier one expired", async () => {
    const old = fakeId();
    const fresh = fakeId();
    const fake = fakeContext({ post: { externalContainerId: old } });
    answerStatus(old, "EXPIRED");
    answerQuota(fake.igUserId, quota(1));
    answerContainer(fake.igUserId, { body: { id: fresh } });
    expect(await adapter().publish(fake.context)).toEqual({ pending: true, containerId: fresh });
  });

  it("refuses without a Meta app and before sending anything", async () => {
    const fake = fakeContext();
    const unconfigured = createInstagramAdapter({ client: () => graphClientFromEnv({}) });
    const error = await failure(unconfigured.publish(fake.context));
    expect(error.error).toMatchObject({ code: "not_configured", retryable: false });
    expect(fake.calls.secrets).toBe(0);
  });

  it("refuses a channel without an account id", async () => {
    const fake = fakeContext({ igUserId: null });
    const error = await failure(adapter().publish(fake.context));
    expect(error.error).toMatchObject({ code: "not_configured", retryable: false });
  });
});

describe("instagram status", () => {
  it("stays pending while IN_PROGRESS, then publishes once and reads the permalink", async () => {
    const containerId = fakeId();
    const mediaId = fakeId();
    const fake = fakeContext({ post: { externalContainerId: containerId } });
    const instance = adapter();

    answerStatus(containerId, "IN_PROGRESS");
    expect(await instance.status(fake.context)).toEqual({ state: "pending" });

    const seen: SeenRequest[] = [];
    answerStatus(containerId, "FINISHED");
    answer(graph(), "POST", v(`/${fake.igUserId}/media_publish`), { body: { id: mediaId } }, seen);
    answerPermalink(mediaId, seen);
    expect(await instance.status(fake.context)).toEqual({
      state: "published",
      externalId: mediaId,
      permalink: `https://www.instagram.com/reel/${mediaId}/`,
    });
    expect(Object.fromEntries(await formOf(seen[0]))).toEqual({ creation_id: containerId });
    expect(seen[1]?.query.get("fields")).toBe("permalink");
    expect(fake.recorded().response).toEqual({
      container_id: containerId,
      status_code: "FINISHED",
      media_id: mediaId,
      permalink: `https://www.instagram.com/reel/${mediaId}/`,
    });
  });

  it("stays pending when media_publish says the media is not ready", async () => {
    const containerId = fakeId();
    const fake = fakeContext({ post: { externalContainerId: containerId } });
    answerStatus(containerId, "FINISHED");
    answer(graph(), "POST", v(`/${fake.igUserId}/media_publish`), {
      status: 400,
      body: graphError(9_007, "The media is not ready for publishing", 2_207_027),
    });
    expect(await adapter().status(fake.context)).toEqual({ state: "pending" });
  });

  it.each([
    ["ERROR", "Error: Media upload has failed with error code 2207026", "2207026"],
    ["EXPIRED", undefined, "EXPIRED"],
  ])(
    "fails a container in %s as invalid_media with its status text",
    async (code, text, platformCode) => {
      const containerId = fakeId();
      const fake = fakeContext({ post: { externalContainerId: containerId } });
      answerStatus(containerId, code, text);
      const result = await adapter().status(fake.context);
      expect(result).toMatchObject({
        state: "failed",
        error: { code: "invalid_media", retryable: false, platformCode },
      });
      if (text !== undefined) {
        expect(result.error?.message).toContain(text);
      }
    },
  );

  it("never sends media_publish twice for one container", async () => {
    const containerId = fakeId();
    const mediaId = fakeId();
    const fake = fakeContext({ post: { externalContainerId: containerId } });
    const instance = adapter({ maxRetries: 0 });
    const publishes: SeenRequest[] = [];

    // Two polls see FINISHED at once: one media_publish answers both.
    answerStatus(containerId, "FINISHED");
    answerStatus(containerId, "FINISHED");
    answer(
      graph(),
      "POST",
      v(`/${fake.igUserId}/media_publish`),
      { body: { id: mediaId } },
      publishes,
    );
    answerPermalink(mediaId);
    answerPermalink(mediaId);
    const [first, second] = await Promise.all([
      instance.status(fake.context),
      instance.status(fake.context),
    ]);
    expect(first).toMatchObject({ state: "published", externalId: mediaId });
    expect(second).toMatchObject({ state: "published", externalId: mediaId });
    expect(publishes).toHaveLength(1);

    // The permalink read fails after the publish; the retry finds the container PUBLISHED and
    // reuses the media id instead of publishing again.
    const other = fakeId();
    const otherMedia = fakeId();
    const retry = fakeContext({ post: { externalContainerId: other }, igUserId: fake.igUserId });
    answerStatus(other, "FINISHED");
    answer(
      graph(),
      "POST",
      v(`/${fake.igUserId}/media_publish`),
      { body: { id: otherMedia } },
      publishes,
    );
    answer(graph(), "GET", v(`/${otherMedia}`), {
      status: 500,
      body: graphError(2, "Service unavailable"),
    });
    expect((await failure(instance.status(retry.context))).error).toMatchObject({
      code: "transient",
      retryable: true,
    });
    answerStatus(other, "PUBLISHED");
    answerPermalink(otherMedia);
    expect(await instance.status(retry.context)).toMatchObject({
      state: "published",
      externalId: otherMedia,
    });
    expect(publishes).toHaveLength(2);
  });

  it("finds the media of a PUBLISHED container whose media id was lost", async () => {
    const containerId = fakeId();
    const mediaId = fakeId();
    const fake = fakeContext({ post: { externalContainerId: containerId } });
    const caption = fake.context.caption().text;
    answerStatus(containerId, "PUBLISHED");
    const seen: SeenRequest[] = [];
    answer(
      graph(),
      "GET",
      v(`/${fake.igUserId}/media`),
      {
        body: {
          data: [
            { id: fakeId(), caption: "another post", media_product_type: "REELS" },
            {
              id: mediaId,
              caption,
              media_product_type: "REELS",
              permalink: `https://www.instagram.com/reel/${mediaId}/`,
              timestamp: new Date().toISOString().replace("Z", "+0000"),
            },
          ],
        },
      },
      seen,
    );
    expect(await adapter().status(fake.context)).toEqual({
      state: "published",
      externalId: mediaId,
      permalink: `https://www.instagram.com/reel/${mediaId}/`,
    });
    expect(seen[0]?.query.get("fields")).toBe("id,permalink,timestamp,caption,media_product_type");
  });

  it("reports a PUBLISHED container as published even when its media is not found", async () => {
    const containerId = fakeId();
    const fake = fakeContext({ post: { externalContainerId: containerId } });
    answerStatus(containerId, "PUBLISHED");
    answer(graph(), "GET", v(`/${fake.igUserId}/media`), { body: { data: [] } });
    expect(await adapter().status(fake.context)).toEqual({ state: "published" });
  });

  it("fails a post without a container for good", async () => {
    const fake = fakeContext();
    const error = await failure(adapter().status(fake.context));
    expect(error.error).toMatchObject({ code: "permanent", retryable: false });
  });
});

describe("instagram errors", () => {
  const usageHeader = (minutes: number) => ({
    "x-business-use-case-usage": JSON.stringify({
      [fakeId()]: [
        { type: "instagram", call_count: 100, estimated_time_to_regain_access: minutes },
      ],
    }),
  });

  it.each([
    ["auth", { status: 400, body: graphError(190, "Error validating access token", 463) }, false],
    [
      "permission",
      { status: 403, body: graphError(10, "Application does not have permission") },
      false,
    ],
    [
      "rate_limited",
      {
        status: 400,
        body: graphError(4, "Application request limit reached"),
        headers: usageHeader(5),
      },
      true,
    ],
    [
      "invalid_media",
      { status: 400, body: graphError(352, "The video format is not supported", 2_207_026) },
      false,
    ],
    [
      "invalid_media",
      { status: 400, body: graphError(9_004, "The media could not be fetched", 2_207_052) },
      false,
    ],
    [
      "transient",
      { status: 400, body: graphError(-2, "It takes too long to download the media", 2_207_003) },
      true,
    ],
    ["transient", { status: 500, body: graphError(2, "Service temporarily unavailable") }, true],
    [
      "permission",
      { status: 400, body: graphError(25, "The Instagram account is restricted", 2_207_050) },
      false,
    ],
    [
      "permanent",
      { status: 400, body: graphError(4, "We restrict certain activity", 2_207_051) },
      false,
    ],
    ["permanent", { status: 400, body: graphError(100, "Invalid parameter") }, false],
  ] as const)("classifies a refused container as %s", async (code, reply, retryable) => {
    const fake = fakeContext();
    answerQuota(fake.igUserId, quota(0));
    answerContainer(fake.igUserId, reply as Reply);
    const error = await failure(adapter().publish(fake.context));
    expect(error.error).toMatchObject({ code, retryable });
    expect(error.error.message).not.toContain(fake.token);
    if (code === "rate_limited") {
      expect(error.error.retryAfterMs).toBe(5 * 60_000);
    }
    // The request is recorded before sending, so a failed call still shows what was sent.
    expect(fake.recorded().request).toMatchObject({ platform: "instagram", pending: true });
  });

  it("reads the publishing limit error of media_publish as rate_limited", async () => {
    const containerId = fakeId();
    const fake = fakeContext({ post: { externalContainerId: containerId } });
    answerStatus(containerId, "FINISHED");
    answer(graph(), "POST", v(`/${fake.igUserId}/media_publish`), {
      status: 400,
      body: graphError(9, "You reached maximum number of posts", 2_207_042),
    });
    const error = await failure(adapter().status(fake.context));
    expect(error.error).toMatchObject({
      code: "rate_limited",
      retryable: true,
      retryAfterMs: INSTAGRAM_QUOTA_RETRY_MS,
      platformCode: "9/2207042",
    });
  });

  it("retries a failing status read and reports a network failure as transient", async () => {
    const containerId = fakeId();
    const fake = fakeContext({ post: { externalContainerId: containerId } });
    answer(graph(), "GET", v(`/${containerId}`), {
      status: 503,
      body: graphError(1, "Unknown error"),
    });
    answerStatus(containerId, "IN_PROGRESS");
    expect(await adapter().status(fake.context)).toEqual({ state: "pending" });

    graph()
      .intercept({ method: "GET", path: (path: string) => path.startsWith(v(`/${containerId}`)) })
      .replyWithError(new Error("socket hang up"));
    const error = await failure(adapter({ maxRetries: 0 }).status(fake.context));
    expect(error.error).toMatchObject({ code: "transient", retryable: true });
  });
});
