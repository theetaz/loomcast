import { describe, expect, it } from "vitest";
import {
  CompetitorUrlError,
  CreateCompetitorScanRequestSchema,
  competitorTag,
  isPublicVideoUrl,
  KbAnalyzeReferencePayloadSchema,
  parseCompetitorUrl,
} from "../src";

describe("parseCompetitorUrl", () => {
  it("reads profile links and handles", () => {
    expect(parseCompetitorUrl("https://www.instagram.com/nasa/?igsh=abc")).toEqual({
      platform: "instagram",
      handle: "nasa",
      profileUrl: "https://instagram.com/nasa",
    });
    expect(parseCompetitorUrl("@unfolded.science")).toMatchObject({
      platform: "instagram",
      handle: "unfolded.science",
    });
    expect(parseCompetitorUrl("kurzgesagt").handle).toBe("kurzgesagt");
    expect(parseCompetitorUrl("https://m.facebook.com/NASA")).toMatchObject({
      platform: "facebook",
      handle: "NASA",
      profileUrl: "https://facebook.com/NASA",
    });
    expect(parseCompetitorUrl("threads.net/@zuck")).toMatchObject({
      platform: "threads",
      handle: "zuck",
      profileUrl: "https://threads.net/@zuck",
    });
  });

  it("refuses posts, other sites and odd handles", () => {
    for (const input of [
      "https://www.instagram.com/reel/DeTUk4sDSp-/",
      "https://facebook.com/watch?v=1",
      "https://tiktok.com/@someone",
      "https://example.com/nasa",
      "unfolded.science",
      "https://instagram.com/",
      "https://instagram.com/a%20b",
      "",
    ]) {
      expect(() => parseCompetitorUrl(input), input).toThrow(CompetitorUrlError);
    }
  });
});

describe("isPublicVideoUrl", () => {
  it("accepts single public videos on the platform's hosts", () => {
    expect(isPublicVideoUrl("https://www.instagram.com/reel/DeTUk4sDSp-/", "instagram")).toBe(true);
    expect(isPublicVideoUrl("https://www.instagram.com/p/DeclSZmF_7I/", "instagram")).toBe(true);
    expect(isPublicVideoUrl("https://www.facebook.com/reel/1871697350483682/", "facebook")).toBe(
      true,
    );
    expect(isPublicVideoUrl("https://www.facebook.com/NASA/videos/123456/", "facebook")).toBe(true);
    expect(isPublicVideoUrl("https://www.threads.net/@zuck/post/C8abc_1", "threads")).toBe(true);
  });

  it("refuses profiles, other platforms, other hosts and odd URLs", () => {
    for (const [url, platform] of [
      ["https://www.instagram.com/nasa/", "instagram"],
      ["https://www.instagram.com/reel/DeTUk4sDSp-/", "facebook"],
      ["http://www.instagram.com/reel/DeTUk4sDSp-/", "instagram"],
      ["https://instagram.com.evil.example/reel/abc/", "instagram"],
      ["https://user:pw@instagram.com/reel/abc/", "instagram"],
      ["https://instagram.com:8443/reel/abc/", "instagram"],
      ["https://www.facebook.com/login/", "facebook"],
      ["https://www.threads.net/@zuck", "threads"],
      ["not a url", "instagram"],
    ] as const) {
      expect(isPublicVideoUrl(url, platform), url).toBe(false);
    }
  });
});

describe("competitorTag", () => {
  it("makes a valid knowledge-base tag", () => {
    expect(competitorTag("instagram", "unfolded.science")).toBe("competitor-ig-unfolded-science");
    expect(competitorTag("facebook", "NASA")).toBe("competitor-fb-nasa");
    const long = competitorTag("threads", "a".repeat(100));
    expect(long.length).toBeLessThanOrEqual(40);
    expect(long).toMatch(/^[a-z0-9][a-z0-9-]{0,39}$/);
  });
});

describe("scan requests and analysis payloads", () => {
  it("defaults to the top 10 and caps at 20", () => {
    expect(CreateCompetitorScanRequestSchema.parse({}).topN).toBe(10);
    expect(CreateCompetitorScanRequestSchema.safeParse({ topN: 21 }).success).toBe(false);
  });

  it("fetches only public video links of the platform", () => {
    const base = {
      workspaceId: "0f11bef5-16a8-46c3-a532-076d15345dcb",
      entryId: "e313dc4c-a67e-4ad8-8a19-5a8c67ca4b8b",
      fetchPublicVideo: true,
    };
    expect(
      KbAnalyzeReferencePayloadSchema.safeParse({
        ...base,
        url: "https://www.instagram.com/reel/DeTUk4sDSp-/",
        platform: "instagram",
      }).success,
    ).toBe(true);
    for (const [url, platform] of [
      ["https://www.instagram.com/nasa/", "instagram"],
      ["https://www.youtube.com/shorts/abc", "youtube"],
      ["https://example.com/video.mp4", "other"],
    ]) {
      expect(KbAnalyzeReferencePayloadSchema.safeParse({ ...base, url, platform }).success).toBe(
        false,
      );
    }
  });
});
