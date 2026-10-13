import { describe, expect, it } from "vitest";
import {
  detectReferencePlatform,
  normalizeReferenceUrl,
  REFERENCE_URL_MAX_LENGTH,
  ReferenceUrlError,
} from "../src";

describe("normalizeReferenceUrl", () => {
  it.each([
    [
      "https://www.instagram.com/reel/C1a2B3c4D5e/?igsh=MTc4MmM1YmI2Ng==",
      "https://instagram.com/reel/C1a2B3c4D5e/",
      "instagram",
    ],
    [
      "https://instagram.com/reel/abc/?igshid=xyz&utm_source=ig_web_copy_link",
      "https://instagram.com/reel/abc/",
      "instagram",
    ],
    [
      "https://www.tiktok.com/@dev/video/7312345678901234567?is_from_webapp=1&utm_campaign=x",
      "https://tiktok.com/@dev/video/7312345678901234567?is_from_webapp=1",
      "tiktok",
    ],
    ["https://vm.tiktok.com/ZMabc123/", "https://vm.tiktok.com/ZMabc123/", "tiktok"],
    [
      "https://m.youtube.com/watch?v=dQw4w9WgXcQ&feature=share&si=AbC",
      "https://youtube.com/watch?v=dQw4w9WgXcQ",
      "youtube",
    ],
    ["https://youtu.be/dQw4w9WgXcQ?si=Zr2r9&t=42", "https://youtu.be/dQw4w9WgXcQ?t=42", "youtube"],
    [
      "https://www.youtube.com/shorts/abc123?feature=share",
      "https://youtube.com/shorts/abc123",
      "youtube",
    ],
    [
      "https://www.threads.net/@dev/post/C9xYz?xmt=AQ",
      "https://threads.net/@dev/post/C9xYz?xmt=AQ",
      "threads",
    ],
    ["https://www.threads.com/@dev/post/C9xYz", "https://threads.com/@dev/post/C9xYz", "threads"],
    [
      "https://x.com/dev/status/1790000000000000000?s=20&ref=home",
      "https://x.com/dev/status/1790000000000000000?s=20",
      "x",
    ],
    ["https://mobile.twitter.com/dev/status/1", "https://mobile.twitter.com/dev/status/1", "x"],
    [
      "https://m.facebook.com/reel/123456?fbclid=IwAR0abc&mibextid=xyz",
      "https://facebook.com/reel/123456?mibextid=xyz",
      "facebook",
    ],
    ["https://fb.watch/abcDEF/", "https://fb.watch/abcDEF/", "facebook"],
    [
      "https://blog.example.com/post?UTM_Medium=email&id=7",
      "https://blog.example.com/post?id=7",
      "other",
    ],
  ])("cleans %s", (input, url, platform) => {
    expect(normalizeReferenceUrl(input)).toEqual({ url, platform });
  });

  it("lowercases the host and keeps the case of the path", () => {
    expect(normalizeReferenceUrl("HTTPS://WWW.Instagram.COM/Reel/AbC/").url).toBe(
      "https://instagram.com/Reel/AbC/",
    );
  });

  it("reads input without a scheme as https and trims it", () => {
    expect(normalizeReferenceUrl("  instagram.com/reel/abc  ")).toEqual({
      url: "https://instagram.com/reel/abc",
      platform: "instagram",
    });
  });

  it("upgrades known platforms to https but keeps http elsewhere", () => {
    expect(normalizeReferenceUrl("http://www.youtube.com/watch?v=a").url).toBe(
      "https://youtube.com/watch?v=a",
    );
    expect(normalizeReferenceUrl("http://example.com/a").url).toBe("http://example.com/a");
  });

  it("drops the query string when only tracking parameters were left", () => {
    expect(normalizeReferenceUrl("https://example.com/a?utm_source=x&si=1").url).toBe(
      "https://example.com/a",
    );
  });

  it("keeps the fragment and a non-default port", () => {
    expect(normalizeReferenceUrl("https://example.com:8443/a?ref=x#t=30").url).toBe(
      "https://example.com:8443/a#t=30",
    );
  });

  it("never reduces a host to a single label", () => {
    expect(normalizeReferenceUrl("https://m.co/a").url).toBe("https://m.co/a");
    expect(normalizeReferenceUrl("https://www.m.example.com/a").url).toBe("https://example.com/a");
  });

  it("does not match a platform by a look-alike host", () => {
    expect(normalizeReferenceUrl("https://notinstagram.com/reel/a").platform).toBe("other");
    expect(normalizeReferenceUrl("https://instagram.com.evil.example/reel/a").platform).toBe(
      "other",
    );
  });

  it.each([
    "",
    "   ",
    "ftp://example.com/video.mp4",
    "javascript:alert(1)",
    "mailto:someone@example.com",
    "https://user:secret@example.com/a",
    "https://localhost/a",
    "http://",
    `https://example.com/${"a".repeat(REFERENCE_URL_MAX_LENGTH)}`,
  ])("rejects %j", (input) => {
    expect(() => normalizeReferenceUrl(input)).toThrow(ReferenceUrlError);
  });

  it("is idempotent", () => {
    const once = normalizeReferenceUrl("https://www.youtube.com/watch?v=a&si=b&feature=c");

    expect(normalizeReferenceUrl(once.url)).toEqual(once);
  });
});

describe("detectReferencePlatform", () => {
  it.each([
    ["WWW.INSTAGRAM.COM", "instagram"],
    ["instagr.am", "instagram"],
    ["music.youtube.com", "youtube"],
    ["youtube-nocookie.com", "youtube"],
    ["twitter.com", "x"],
    ["fb.com", "facebook"],
    ["example.com", "other"],
  ])("detects %s as %s", (host, platform) => {
    expect(detectReferencePlatform(host)).toBe(platform);
  });
});
