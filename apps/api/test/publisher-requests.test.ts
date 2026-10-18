import { randomUUID } from "node:crypto";
import {
  type MediaPublishRequest,
  PLATFORMS,
  type Platform,
  type PublishMediaItem,
  type PublishRequest,
  type TextPublishRequest,
  type VideoPublishRequest,
} from "@loomcast/contracts";
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
  FACEBOOK_PHOTO_LIMITS,
  FACEBOOK_VIDEO_STORY_LIMITS,
  itemContainerPlaceholder,
  limitCaption,
  PLACEHOLDERS,
  PLATFORM_CAPTION_LIMITS,
  photoPlaceholder,
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

function request(
  platform: Platform,
  overrides: Partial<VideoPublishRequest> = {},
): VideoPublishRequest {
  return {
    platform,
    format: "reel",
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

describe("facebook formats", () => {
  const page = "1784140000000";

  function photo(overrides: Partial<PublishMediaItem> = {}): PublishMediaItem {
    return {
      type: "image",
      url: `https://media.example.test/p/${randomUUID()}.jpg`,
      mime: "image/jpeg",
      bytes: 1_048_576,
      width: 1_080,
      height: 1_350,
      durationMs: null,
      ...overrides,
    };
  }

  function clip(overrides: Partial<PublishMediaItem> = {}): PublishMediaItem {
    return {
      type: "video",
      url: `https://media.example.test/p/${randomUUID()}.mp4`,
      mime: "video/mp4",
      bytes: 9 * 1_048_576,
      width: 1_080,
      height: 1_920,
      durationMs: 20_000,
      ...overrides,
    };
  }

  function composed(
    format: MediaPublishRequest["format"],
    items: PublishMediaItem[],
    caption = "Ownership in sixty seconds",
  ): MediaPublishRequest {
    return { platform: "facebook", format, externalId: page, caption, media: items };
  }

  function text(caption: string, link?: string): TextPublishRequest {
    return {
      platform: "facebook",
      format: "text",
      externalId: page,
      caption,
      ...(link === undefined ? {} : { options: { facebook: { link } } }),
    };
  }

  const plan = (input: PublishRequest, facts: typeof media | null = null) =>
    buildFacebookPublish({ request: input, media: facts, accessToken: token });

  it("builds a Page video from the public url with its title", () => {
    const input = request("facebook", {
      format: "video",
      width: 1_920,
      height: 1_080,
      options: { facebook: { title: "Ownership" } },
    });
    const built = plan(input, media);
    expect(built.pending).toBe(true);
    expect(built.steps).toEqual([
      {
        step: "upload_video",
        method: "POST",
        api: "graph",
        path: `/${page}/videos`,
        headers: { Authorization: `Bearer ${token}` },
        bodyEncoding: "json",
        body: { file_url: input.videoUrl, description: input.caption, title: "Ownership" },
      },
    ]);
  });

  it("builds a photo post with its caption and alt text, then reads the permalink", () => {
    const item = photo({ altText: "A crab on a keyboard" });
    const built = plan(composed("image", [item]));
    expect(built.pending).toBe(false);
    expect(built.steps.map((step) => [step.step, step.method, step.path])).toEqual([
      ["upload_photo", "POST", `/${page}/photos`],
      ["permalink", "GET", `/${PLACEHOLDERS.postId}`],
    ]);
    expect(built.steps[0]?.body).toEqual({
      url: item.url,
      caption: "Ownership in sixty seconds",
      alt_text_custom: "A crab on a keyboard",
    });
    expect(built.steps[1]?.query).toEqual({ fields: "permalink_url" });
  });

  it("builds a multi-photo post from unpublished photos", () => {
    const items = [photo(), photo(), photo()];
    const built = plan(composed("carousel", items));
    expect(built.pending).toBe(false);
    expect(built.steps.map((step) => step.step)).toEqual([
      "upload_photo",
      "upload_photo",
      "upload_photo",
      "create_post",
      "permalink",
    ]);
    expect(built.steps.slice(0, 3).map((step) => step.body)).toEqual(
      items.map((item) => ({ url: item.url, published: false })),
    );
    expect(built.steps[3]).toMatchObject({ method: "POST", path: `/${page}/feed` });
    expect(built.steps[3]?.body).toEqual({
      message: "Ownership in sixty seconds",
      "attached_media[0]": JSON.stringify({ media_fbid: photoPlaceholder(0) }),
      "attached_media[1]": JSON.stringify({ media_fbid: photoPlaceholder(1) }),
      "attached_media[2]": JSON.stringify({ media_fbid: photoPlaceholder(2) }),
    });
    expect(photoPlaceholder(0)).toBe("{photo-id-1}");
  });

  it("builds text posts with a link, leaving out an empty message", () => {
    const built = plan(text("Read the write-up", "https://example.test/post"));
    expect(built.steps.map((step) => [step.step, step.path])).toEqual([
      ["create_post", `/${page}/feed`],
      ["permalink", `/${PLACEHOLDERS.postId}`],
    ]);
    expect(built.steps[0]?.body).toEqual({
      message: "Read the write-up",
      link: "https://example.test/post",
    });
    expect(plan(text("  ", "https://example.test/post")).steps[0]?.body).toEqual({
      link: "https://example.test/post",
    });
  });

  it("builds photo stories and video stories", () => {
    const still = photo();
    const photoStory = plan(composed("story", [still]));
    expect(photoStory.pending).toBe(false);
    expect(photoStory.steps.map((step) => [step.step, step.method, step.path])).toEqual([
      ["upload_photo", "POST", `/${page}/photos`],
      ["publish_story", "POST", `/${page}/photo_stories`],
      ["stories", "GET", `/${page}/stories`],
    ]);
    expect(photoStory.steps[0]?.body).toEqual({ url: still.url, published: false });
    expect(photoStory.steps[1]?.body).toEqual({ photo_id: PLACEHOLDERS.photoId });

    const moving = clip();
    const videoStory = plan(composed("story", [moving]));
    expect(videoStory.pending).toBe(true);
    expect(videoStory.steps.map((step) => [step.step, step.api, step.path])).toEqual([
      ["start_upload", "graph", `/${page}/video_stories`],
      ["upload", "rupload", `/${PLACEHOLDERS.videoId}`],
      ["finish_upload", "graph", `/${page}/video_stories`],
    ]);
    expect(videoStory.steps[1]?.headers).toEqual({
      Authorization: `OAuth ${token}`,
      file_url: moving.url,
    });
    expect(videoStory.steps[2]?.body).toEqual({
      upload_phase: "finish",
      video_id: PLACEHOLDERS.videoId,
    });
  });

  it("validates every Facebook format", () => {
    const fields = (input: PublishRequest, facts: typeof media | null = null) =>
      validatePublishRequest(input, facts).map((issue) => issue.field);

    expect(
      fields(request("facebook", { format: "video", width: 1_920, height: 1_080 }), media),
    ).toEqual([]);
    expect(
      fields(request("facebook", { format: "video", durationMs: 30 * 60_000 }), media),
    ).toEqual(["duration"]);
    expect(fields(request("facebook", { format: "video" }))).toEqual(["video"]);

    expect(fields(composed("image", [photo()]))).toEqual([]);
    expect(fields(composed("image", [photo({ mime: "image/webp" })]))).toEqual(["media.0"]);
    expect(
      validatePublishRequest(composed("image", [photo({ mime: "image/webp" })]), null),
    ).toEqual([expect.objectContaining({ message: expect.stringContaining("JPEG or PNG") })]);
    expect(
      fields(composed("image", [photo({ bytes: FACEBOOK_PHOTO_LIMITS.maxBytes + 1 })])),
    ).toEqual(["media.0"]);

    expect(fields(composed("carousel", [photo(), photo()]))).toEqual([]);
    expect(validatePublishRequest(composed("carousel", [photo(), clip()]), null)).toEqual([
      { field: "media", message: expect.stringContaining("photos only") },
    ]);
    expect(fields(composed("carousel", [photo(), photo({ mime: "image/webp" })]))).toEqual([
      "media.1",
    ]);

    expect(fields(composed("story", [photo()]))).toEqual([]);
    expect(fields(composed("story", [clip()]))).toEqual([]);
    expect(fields(composed("story", [clip({ durationMs: 70_000 })]))).toEqual(["duration"]);
    expect(fields(composed("story", [clip({ width: 1_920, height: 1_080 })]))).toContain(
      "dimensions",
    );
    expect(fields(composed("story", [clip({ width: null, height: null })]))).toEqual([]);
    expect(fields(composed("story", [clip({ durationMs: null })]))).toEqual(["media.0"]);
    expect(FACEBOOK_VIDEO_STORY_LIMITS.maxDurationMs).toBe(60_000);

    expect(fields(text("Words only"))).toEqual([]);
    expect(fields(text("", "https://example.test/post"))).toEqual([]);
    expect(fields(text(" "))).toEqual(["caption"]);
  });
});

describe("instagram formats", () => {
  const account = "1784140000000";
  const photo = (overrides: Partial<PublishMediaItem> = {}): PublishMediaItem => ({
    type: "image",
    url: `https://media.example.test/p/${randomUUID()}/photo.jpg`,
    mime: "image/jpeg",
    bytes: 2 * 1_048_576,
    width: 1_080,
    height: 1_350,
    durationMs: null,
    ...overrides,
  });
  const clip = (overrides: Partial<PublishMediaItem> = {}): PublishMediaItem => ({
    type: "video",
    url: `https://media.example.test/p/${randomUUID()}/clip.mp4`,
    mime: "video/mp4",
    bytes: 20 * 1_048_576,
    width: 1_080,
    height: 1_920,
    durationMs: 15_000,
    ...overrides,
  });
  const composed = (
    format: MediaPublishRequest["format"],
    items: PublishMediaItem[],
    overrides: Partial<MediaPublishRequest> = {},
  ): MediaPublishRequest => ({
    platform: "instagram",
    format,
    externalId: account,
    caption: "Ownership in sixty seconds",
    media: items,
    ...overrides,
  });
  const plan = (input: MediaPublishRequest | VideoPublishRequest) =>
    buildInstagramPublish({
      request: input,
      media: input.format === "reel" ? media : null,
      accessToken: token,
    });

  it("builds a photo container with alt text, collaborators and a location", () => {
    const item = photo({ altText: "A crab holding a borrow checker" });
    const steps = plan(
      composed("image", [item], {
        options: { instagram: { collaborators: ["rustlang"], locationId: "110123" } },
      }),
    ).steps;
    expect(steps.map((step) => step.step)).toEqual(["publishing_limit", "create_container"]);
    expect(steps[1]).toEqual({
      step: "create_container",
      method: "POST",
      api: "graph",
      path: `/${account}/media`,
      headers: { Authorization: `Bearer ${token}` },
      bodyEncoding: "json",
      body: {
        image_url: item.url,
        caption: "Ownership in sixty seconds",
        alt_text: "A crab holding a borrow checker",
        collaborators: ["rustlang"],
        location_id: "110123",
      },
    });
  });

  it("builds a carousel: item containers, then the carousel container naming them", () => {
    const items = [photo({ altText: "First" }), clip()];
    const result = plan(
      composed("carousel", items, { options: { instagram: { collaborators: ["a.b"] } } }),
    );
    expect(result.pending).toBe(true);
    expect(result.steps.map((step) => step.step)).toEqual([
      "publishing_limit",
      "create_item_container",
      "create_item_container",
      "create_carousel_container",
    ]);
    expect(result.steps[1]?.body).toEqual({
      is_carousel_item: true,
      image_url: items[0]?.url,
      alt_text: "First",
    });
    expect(result.steps[2]?.body).toEqual({
      is_carousel_item: true,
      media_type: "VIDEO",
      video_url: items[1]?.url,
    });
    expect(result.steps[3]?.body).toEqual({
      media_type: "CAROUSEL",
      children: `${itemContainerPlaceholder(0)},${itemContainerPlaceholder(1)}`,
      caption: "Ownership in sixty seconds",
      collaborators: ["a.b"],
    });
    expect(itemContainerPlaceholder(1)).toBe("{item-container-id-2}");
  });

  it("builds stories without a caption", () => {
    const still = photo({ width: 1_080, height: 1_920 });
    expect(plan(composed("story", [still])).steps[1]?.body).toEqual({
      media_type: "STORIES",
      image_url: still.url,
    });
    const moving = clip();
    expect(plan(composed("story", [moving])).steps[1]?.body).toEqual({
      media_type: "STORIES",
      video_url: moving.url,
    });
  });

  it("sends the Reels options: share_to_feed, thumb_offset without a poster, collaborators", () => {
    const reel = request("instagram", {
      options: {
        instagram: {
          shareToFeed: false,
          thumbOffsetMs: 2_500,
          collaborators: ["rustlang"],
          locationId: "42",
        },
      },
    });
    expect(plan(reel).steps[1]?.body).toEqual({
      media_type: "REELS",
      video_url: reel.videoUrl,
      caption: reel.caption,
      share_to_feed: false,
      thumb_offset: 2_500,
      collaborators: ["rustlang"],
      location_id: "42",
    });
    const withPoster = { ...reel, posterUrl: "https://media.example.test/poster.jpg" };
    const body = plan(withPoster).steps[1]?.body;
    expect(body).toMatchObject({ cover_url: withPoster.posterUrl });
    expect(body).not.toHaveProperty("thumb_offset");
  });

  it("refuses formats Instagram does not publish", () => {
    expect(validatePublishRequest({ ...request("instagram"), format: "video" }, media)).toEqual([
      { field: "format", message: "Instagram does not publish videos." },
    ]);
    expect(
      validatePublishRequest(
        { platform: "instagram", format: "text", externalId: account, caption: "Hi" },
        null,
      ),
    ).toEqual([{ field: "format", message: "Instagram does not publish text posts." }]);
  });

  it("accepts JPEG photos within the limits and asks for a JPEG otherwise", () => {
    expect(validatePublishRequest(composed("image", [photo()]), null)).toEqual([]);
    expect(validatePublishRequest(composed("image", [photo({ mime: "image/png" })]), null)).toEqual(
      [
        {
          field: "media.0",
          message:
            "Instagram publishes JPEG photos only; the photo is image/png. Upload it as a JPEG.",
        },
      ],
    );
    const messages = (item: PublishMediaItem) =>
      validatePublishRequest(composed("image", [item]), null).map((issue) => issue.message);
    expect(messages(photo({ bytes: 9 * 1_048_576 }))).toEqual(["The photo is larger than 8 MB."]);
    expect(messages(photo({ width: 1_080, height: 1_920 }))).toEqual([
      "The photo is 1080×1920; Instagram takes photos from 4:5 (portrait) to 1.91:1 (landscape).",
    ]);
    expect(messages(photo({ width: 200, height: 200 }))).toEqual([
      "The photo must be at least 320 pixels wide.",
    ]);
    // 4:5 exactly and 1.91:1 pass; unknown dimensions are not checked.
    expect(messages(photo({ width: 1_080, height: 566 }))).toEqual([]);
    expect(messages(photo({ width: null, height: null }))).toEqual([]);
    expect(
      validatePublishRequest(composed("image", [clip()]), null).map((issue) => issue.message),
    ).toEqual(["An Instagram photo post carries a photo."]);
  });

  it("checks carousel item counts and each item's limits", () => {
    expect(validatePublishRequest(composed("carousel", [photo(), clip()]), null)).toEqual([]);
    expect(validatePublishRequest(composed("carousel", [photo()]), null)).toEqual([
      { field: "media", message: "An Instagram carousel carries 2 to 10 photos or videos." },
    ]);
    expect(
      validatePublishRequest(
        composed("carousel", [photo({ mime: "image/webp" }), clip({ durationMs: 90_000 })]),
        null,
      ),
    ).toEqual([
      {
        field: "media.0",
        message:
          "Instagram publishes JPEG photos only; photo 1 is image/webp. Upload it as a JPEG.",
      },
      { field: "media.1", message: "Video 2 runs 90 s; it must run 3 s to 60 s." },
    ]);
  });

  it("checks story limits and refuses story options Instagram ignores", () => {
    expect(validatePublishRequest(composed("story", [clip()]), null)).toEqual([]);
    expect(
      validatePublishRequest(
        composed("story", [clip({ durationMs: 61_000, bytes: 101 * 1_048_576 })]),
        null,
      ).map((issue) => issue.message),
    ).toEqual([
      "The video is larger than 100 MB.",
      "The video runs 61 s; it must run 3 s to 60 s.",
    ]);
    // A tall photo is fine in a story; a caption is never sent, so its mentions are not counted.
    const mentions = Array.from({ length: 21 }, (_, index) => `@user${index}`).join(" ");
    expect(
      validatePublishRequest(
        composed("story", [photo({ width: 1_080, height: 1_920 })], { caption: mentions }),
        null,
      ),
    ).toEqual([]);
    expect(
      validatePublishRequest(
        composed("story", [photo()], {
          options: { instagram: { collaborators: ["a"], locationId: "1" } },
        }),
        null,
      ).map((issue) => issue.field),
    ).toEqual(["options", "options"]);
    expect(
      validatePublishRequest(composed("carousel", [photo(), photo()], { caption: mentions }), null),
    ).toEqual([{ field: "caption", message: "The caption mentions more than 20 accounts." }]);
  });

  it("refuses a Reel cover frame past the end of the video", () => {
    expect(
      validatePublishRequest(
        request("instagram", { options: { instagram: { thumbOffsetMs: 50_000 } } }),
        media,
      ),
    ).toEqual([{ field: "options", message: "The cover frame is past the end of the video." }]);
  });
});
