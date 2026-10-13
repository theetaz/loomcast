import { randomUUID } from "node:crypto";
import { PLATFORMS, type Platform, type PublishRequest } from "@loomcast/contracts";
import { describe, expect, it } from "vitest";
import {
  buildCaption,
  buildFacebookPublish,
  buildInstagramFinish,
  buildInstagramPublish,
  buildPublishPlan,
  buildThreadsPublish,
  buildXPublish,
  captionLength,
  limitCaption,
  PLACEHOLDERS,
  PLATFORM_CAPTION_LIMITS,
  REDACTED,
  redactRequest,
  resolveRequestUrl,
  validatePublishRequest,
  X_SEGMENT_BYTES,
  xWeightedLength,
} from "../src/modules/publisher";
import { testPassword } from "./support";

// Tokens are generated per run; the suite holds no credential-like literals.
const token = testPassword("access");
const media = { bytes: 9 * 1_048_576, mime: "video/mp4" };

function request(platform: Platform, overrides: Partial<PublishRequest> = {}): PublishRequest {
  return {
    platform,
    externalId: "1784140000000",
    videoUrl: `https://media.example.test/p/${randomUUID()}/render.mp4`,
    caption: "Ownership in sixty seconds",
    durationMs: 45_000,
    width: 1_080,
    height: 1_920,
    ...overrides,
  };
}

describe("request builders", () => {
  it("builds the Instagram Reels container after a quota check", () => {
    const input = request("instagram", { posterUrl: "https://media.example.test/p/poster.jpg" });
    const plan = buildInstagramPublish({ request: input, media, accessToken: token });
    expect(plan.pending).toBe(true);
    expect(plan.steps).toEqual([
      {
        step: "publishing_limit",
        method: "GET",
        api: "graph",
        path: "/1784140000000/content_publishing_limit",
        query: { fields: "quota_usage,config" },
        headers: { Authorization: `Bearer ${token}` },
      },
      {
        step: "create_container",
        method: "POST",
        api: "graph",
        path: "/1784140000000/media",
        headers: { Authorization: `Bearer ${token}` },
        bodyEncoding: "json",
        body: {
          media_type: "REELS",
          video_url: input.videoUrl,
          caption: input.caption,
          share_to_feed: true,
          cover_url: input.posterUrl,
        },
      },
    ]);
    const finish = buildInstagramFinish("1784140000000", "c-1", { accessToken: token });
    expect(finish.map((step) => [step.method, step.path])).toEqual([
      ["GET", "/c-1"],
      ["POST", "/1784140000000/media_publish"],
      ["GET", `/${PLACEHOLDERS.mediaId}`],
    ]);
    expect(finish[1]?.body).toEqual({ creation_id: "c-1" });
  });

  it("builds Facebook Page Reels start, upload from URL and finish", () => {
    const input = request("facebook");
    const plan = buildFacebookPublish({ request: input, media, accessToken: token });
    expect(plan.steps.map((step) => [step.step, step.api, step.path])).toEqual([
      ["start_upload", "graph", "/1784140000000/video_reels"],
      ["upload", "rupload", `/${PLACEHOLDERS.videoId}`],
      ["finish_upload", "graph", "/1784140000000/video_reels"],
    ]);
    expect(plan.steps[1]?.headers).toEqual({
      Authorization: `OAuth ${token}`,
      file_url: input.videoUrl,
    });
    expect(plan.steps[2]?.body).toEqual({
      upload_phase: "finish",
      video_id: PLACEHOLDERS.videoId,
      video_state: "PUBLISHED",
      description: input.caption,
    });
  });

  it("builds Threads video containers with the token as a parameter", () => {
    const input = request("threads");
    const plan = buildThreadsPublish({ request: input, media, accessToken: token });
    expect(plan.steps[0]?.query).toEqual({ fields: "quota_usage,config", access_token: token });
    expect(plan.steps[1]).toMatchObject({
      method: "POST",
      api: "threads",
      path: "/1784140000000/threads",
      bodyEncoding: "form",
      body: { media_type: "VIDEO", video_url: input.videoUrl, text: input.caption },
    });
  });

  it("builds X chunked uploads in 4 MB segments", () => {
    const plan = buildXPublish({ request: request("x"), media, accessToken: token });
    const appends = plan.steps.filter((step) => step.step === "append");
    expect(appends).toHaveLength(Math.ceil(media.bytes / X_SEGMENT_BYTES));
    expect(plan.steps[0]?.body).toEqual({
      media_type: "video/mp4",
      total_bytes: media.bytes,
      media_category: "tweet_video",
    });
    expect(appends.at(-1)?.body).toEqual({
      segment_index: 2,
      media: `{bytes ${2 * X_SEGMENT_BYTES}-${media.bytes - 1}}`,
    });
    expect(plan.steps.at(-1)?.path).toBe(`/2/media/upload/${PLACEHOLDERS.mediaId}/finalize`);
  });

  it("dispatches by platform and resolves URLs against versioned bases", () => {
    for (const platform of PLATFORMS) {
      const plan = buildPublishPlan({ request: request(platform), media, accessToken: token });
      expect(plan.platform).toBe(platform);
      expect(plan.steps.length).toBeGreaterThan(0);
    }
    const [limit] = buildInstagramPublish({
      request: request("instagram"),
      media,
      accessToken: token,
    }).steps;
    if (limit === undefined) throw new Error("missing step");
    expect(
      resolveRequestUrl(limit, {
        graph: "https://graph.facebook.com/v25.0/",
        rupload: "https://rupload.facebook.com/video-upload/v25.0",
        threads: "https://graph.threads.net/v1.0",
        x: "https://api.x.com",
      }),
    ).toBe(
      "https://graph.facebook.com/v25.0/1784140000000/content_publishing_limit?fields=quota_usage%2Cconfig",
    );
  });

  it("enforces caption limits in the builders", () => {
    const long = "word ".repeat(700).trim();
    for (const platform of PLATFORMS) {
      const plan = buildPublishPlan({
        request: request(platform, { caption: long.slice(0, 2_200) }),
        media,
        accessToken: token,
      });
      const text = JSON.stringify(plan);
      const sent = plan.steps
        .map((step) => step.body?.caption ?? step.body?.description ?? step.body?.text)
        .find((value) => typeof value === "string");
      if (platform === "x") {
        // X posts the caption only after processing; the publish plan has no text.
        expect(text).not.toContain("word word");
        continue;
      }
      expect(typeof sent).toBe("string");
      expect(captionLength(platform, sent as string)).toBeLessThanOrEqual(
        PLATFORM_CAPTION_LIMITS[platform].maxLength,
      );
    }
  });

  it("validates media against each platform's limits", () => {
    expect(validatePublishRequest(request("instagram"), media)).toEqual([]);
    expect(
      validatePublishRequest(request("facebook", { durationMs: 120_000 }), media).map(
        (issue) => issue.field,
      ),
    ).toEqual(["duration"]);
    expect(
      validatePublishRequest(request("instagram"), { bytes: 400 * 1_048_576, mime: "video/mp4" }),
    ).toEqual([expect.objectContaining({ field: "size" })]);
    expect(validatePublishRequest(request("x"), { bytes: 1_000, mime: "video/quicktime" })).toEqual(
      [expect.objectContaining({ field: "video" })],
    );
    const mentions = Array.from({ length: 21 }, (_, index) => `@user${index}`).join(" ");
    expect(
      validatePublishRequest(request("instagram", { caption: mentions }), media).map(
        (issue) => issue.field,
      ),
    ).toEqual(["caption"]);
  });
});

describe("captions", () => {
  it("composes text, call to action and distinct hashtags", () => {
    const caption = buildCaption("instagram", {
      text: "Ownership in sixty seconds",
      cta: "Follow for more",
      hashtags: ["rust", "Rust", "#shorts"],
    });
    expect(caption.text).toBe("Ownership in sixty seconds\n\nFollow for more\n\n#rust #shorts");
    expect(caption).toMatchObject({ truncated: false, droppedHashtags: [], issues: [] });
  });

  it("drops hashtags beyond Instagram's 30, counting those in the text", () => {
    const tags = Array.from({ length: 35 }, (_, index) => `tag${index}`);
    const caption = buildCaption("instagram", { text: "Two #in #text", hashtags: tags });
    expect((caption.text.match(/#/g) ?? []).length).toBe(30);
    expect(caption.droppedHashtags).toHaveLength(7);
  });

  it("drops hashtags, then the call to action, then cuts the text to fit Threads", () => {
    const text = "Rust ownership explained ".repeat(30).trim();
    const caption = buildCaption("threads", { text, cta: "Follow", hashtags: ["rust"] });
    expect(captionLength("threads", caption.text)).toBeLessThanOrEqual(500);
    expect(caption.text.endsWith("…")).toBe(true);
    expect(caption.text).not.toContain("#rust");
    expect(caption).toMatchObject({ truncated: true, droppedHashtags: ["rust"] });
  });

  it("counts emoji by their UTF-8 length on Threads", () => {
    expect(captionLength("threads", "🦀🦀")).toBe(8);
    expect(captionLength("instagram", "🦀🦀")).toBe(2);
    const fitted = limitCaption("threads", "🦀".repeat(200));
    expect(captionLength("threads", fitted)).toBeLessThanOrEqual(500);
  });

  it("weighs X text: links 23, wide characters 2", () => {
    expect(xWeightedLength("hello")).toBe(5);
    expect(xWeightedLength(`see https://example.test/${"a".repeat(80)}`)).toBe(4 + 23);
    expect(xWeightedLength("日本")).toBe(4);
    const fitted = limitCaption("x", "日本語".repeat(100));
    expect(xWeightedLength(fitted)).toBeLessThanOrEqual(280);
    expect(limitCaption("x", fitted)).toBe(fitted);
  });

  it("reports more than 20 mentions on Instagram", () => {
    const text = Array.from({ length: 21 }, (_, index) => `@user${index}`).join(" ");
    expect(buildCaption("instagram", { text }).issues).toEqual([
      expect.objectContaining({ code: "too_many_mentions" }),
    ]);
  });
});

describe("redaction", () => {
  it("replaces credentials in headers, bodies and URLs, and is idempotent", () => {
    const secret = testPassword("client");
    const redacted = redactRequest({
      headers: { Authorization: `Bearer ${token}`, file_url: "https://media.example.test/v.mp4" },
      query: { fields: "permalink", access_token: token },
      body: { client_secret: secret, appsecret_proof: secret, creation_id: "c-1" },
      url: `https://graph.example.test/me?fields=id&access_token=${token}`,
      nested: [{ refreshToken: token, ok: true }],
    });
    expect(JSON.stringify(redacted)).not.toContain(token);
    expect(JSON.stringify(redacted)).not.toContain(secret);
    expect(redacted).toEqual({
      headers: {
        Authorization: `Bearer ${REDACTED}`,
        file_url: "https://media.example.test/v.mp4",
      },
      query: { fields: "permalink", access_token: REDACTED },
      body: { client_secret: REDACTED, appsecret_proof: REDACTED, creation_id: "c-1" },
      url: "https://graph.example.test/me?fields=id&access_token=%5Bredacted%5D",
      nested: [{ refreshToken: REDACTED, ok: true }],
    });
    expect(redactRequest(redacted)).toEqual(redacted);
  });

  it("leaves a plan built with the redacted marker unchanged", () => {
    for (const platform of PLATFORMS) {
      const plan = buildPublishPlan({ request: request(platform), media, accessToken: REDACTED });
      expect(redactRequest(plan as never)).toEqual(plan);
    }
  });
});
