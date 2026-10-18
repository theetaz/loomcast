import { describe, expect, it } from "vitest";
import {
  canTransition,
  formatMediaIssues,
  isPublishable,
  MAX_POST_MEDIA,
  mediaTypeOfMime,
  PLATFORM_FORMATS,
  PLATFORMS,
  POST_FORMATS,
  PostOptionsSchema,
  PublishRequestSchema,
  platformSupportsFormat,
  stageForArtifacts,
} from "../src";

const image = { type: "image" } as const;
const video = { type: "video" } as const;

describe("post formats", () => {
  it("lists only known formats for every platform", () => {
    for (const platform of PLATFORMS) {
      expect(PLATFORM_FORMATS[platform].length).toBeGreaterThan(0);
      for (const format of PLATFORM_FORMATS[platform]) {
        expect(POST_FORMATS).toContain(format);
      }
      expect(platformSupportsFormat(platform, "reel")).toBe(true);
    }
    expect(platformSupportsFormat("instagram", "text")).toBe(false);
    expect(platformSupportsFormat("facebook", "text")).toBe(true);
    expect(platformSupportsFormat("threads", "carousel")).toBe(false);
  });

  it("reads the media type of a MIME type", () => {
    expect(mediaTypeOfMime("image/jpeg")).toBe("image");
    expect(mediaTypeOfMime("video/quicktime")).toBe("video");
    expect(mediaTypeOfMime("audio/mpeg")).toBeNull();
  });

  it("checks the media of each format", () => {
    expect(isPublishable({ format: "reel", renderAssetId: "r" })).toBe(true);
    expect(isPublishable({ format: "reel", media: [video] })).toBe(true);
    expect(isPublishable({ format: "reel", media: [image] })).toBe(false);
    expect(isPublishable({ format: "reel" })).toBe(false);
    expect(isPublishable({ renderAssetId: "r" })).toBe(true);
    expect(isPublishable({ format: "image", media: [image] })).toBe(true);
    expect(isPublishable({ format: "image", media: [image, image] })).toBe(false);
    expect(isPublishable({ format: "image", media: [video] })).toBe(false);
    expect(isPublishable({ format: "carousel", media: [image] })).toBe(false);
    expect(isPublishable({ format: "carousel", media: [image, video] })).toBe(true);
    expect(
      isPublishable({ format: "carousel", media: Array(MAX_POST_MEDIA + 1).fill(image) }),
    ).toBe(false);
    expect(isPublishable({ format: "story", media: [video] })).toBe(true);
    expect(isPublishable({ format: "story", media: [] })).toBe(false);
    expect(isPublishable({ format: "text" })).toBe(true);
    expect(isPublishable({ format: "text", media: [image] })).toBe(false);
    expect(formatMediaIssues({ format: "carousel", media: [image] })).toEqual([
      "A carousel post needs at least 2 items.",
    ]);
  });

  it("puts a composed post at render once its media fit", () => {
    expect(stageForArtifacts({ format: "image", media: [] })).toBe("idea");
    expect(stageForArtifacts({ format: "image", media: [image] })).toBe("render");
    expect(stageForArtifacts({ format: "text" })).toBe("render");
    expect(stageForArtifacts({ format: "reel", media: [video] })).toBe("render");
    expect(stageForArtifacts({ format: "reel" })).toBe("idea");
    expect(stageForArtifacts({ format: "reel", script: {} })).toBe("script");
  });

  it("lets a composed post be submitted and approved without a render", () => {
    const photo = { format: "image", media: [image] } as const;
    expect(canTransition("render", "review", "user", photo)).toBe(true);
    expect(canTransition("review", "approved", "user", photo)).toBe(true);
    expect(canTransition("review", "approved", "user", { format: "image", media: [] })).toBe(false);
  });

  it("parses publish requests by format", () => {
    const base = { platform: "instagram", externalId: "17841400000000001", caption: "Hello" };
    const item = {
      type: "image",
      url: "https://media.example.test/a.jpg",
      mime: "image/jpeg",
      bytes: 1_000,
      width: 1_080,
      height: 1_350,
      durationMs: null,
    };
    expect(
      PublishRequestSchema.safeParse({ ...base, format: "image", media: [item] }).success,
    ).toBe(true);
    expect(PublishRequestSchema.safeParse({ ...base, format: "image", media: [] }).success).toBe(
      false,
    );
    expect(
      PublishRequestSchema.safeParse({
        ...base,
        format: "carousel",
        media: [item, { ...item, url: "http://media.example.test/b.jpg" }],
      }).success,
    ).toBe(false);
    expect(PublishRequestSchema.safeParse({ ...base, format: "text" }).success).toBe(true);
    expect(PublishRequestSchema.safeParse({ ...base, format: "reel" }).success).toBe(false);
  });

  it("checks post options", () => {
    expect(
      PostOptionsSchema.safeParse({
        instagram: { collaborators: ["loom.cast"], shareToFeed: false },
        facebook: { link: "https://loomcast.example/post", title: "Ownership" },
      }).success,
    ).toBe(true);
    expect(
      PostOptionsSchema.safeParse({ instagram: { collaborators: ["a", "b", "c", "d"] } }).success,
    ).toBe(false);
    expect(PostOptionsSchema.safeParse({ instagram: { unknown: true } }).success).toBe(false);
    expect(PostOptionsSchema.safeParse({ facebook: { link: "ftp://example.test" } }).success).toBe(
      false,
    );
  });
});
