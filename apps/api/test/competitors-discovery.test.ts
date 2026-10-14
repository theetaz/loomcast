import { COMPETITOR_CAPTION_MAX_LENGTH } from "@loomcast/contracts";
import { describe, expect, it } from "vitest";
import {
  BUSINESS_DISCOVERY_NOT_FOUND_SUBCODE,
  businessDiscovery,
  businessDiscoveryFields,
  createGraphClient,
  type DiscoveredMedia,
  type FetchLike,
  MetaGraphError,
} from "../src/lib/meta-graph";
import {
  insightsMarkdown,
  linkedVideos,
  rankVideos,
  scanVideoTitle,
} from "../src/modules/competitors";
import { fakeCredential, GRAPH_ORIGIN, GRAPH_VERSION, graphError } from "./oauth-support";

function media(id: string, values: Partial<DiscoveredMedia> = {}): DiscoveredMedia {
  return {
    id,
    mediaType: "VIDEO",
    mediaProductType: "REELS",
    caption: `Caption ${id}`,
    likeCount: 0,
    commentsCount: 0,
    viewCount: 0,
    timestamp: "2026-09-01T10:00:00+0000",
    permalink: `https://www.instagram.com/reel/${id}/`,
    ...values,
  };
}

describe("rankVideos", () => {
  it("keeps videos with public links and ranks them by views, then likes plus comments", () => {
    const ranked = rankVideos(
      [
        media("A1", { viewCount: 100 }),
        media("B2", { viewCount: 5_000 }),
        media("C3", { mediaType: "IMAGE", mediaProductType: "FEED", viewCount: 90_000 }),
        media("D4", { viewCount: null, likeCount: 900 }),
        media("E5", { viewCount: 100, likeCount: 10, commentsCount: 5 }),
        media("F6", { mediaProductType: "FEED", mediaType: "VIDEO", viewCount: 300 }),
        media("G7", { permalink: "https://example.com/reel/G7/", viewCount: 80_000 }),
        media("H8", { permalink: null, viewCount: 70_000 }),
      ],
      4,
    );
    expect(ranked.map((video) => video.externalId)).toEqual(["B2", "F6", "E5", "A1"]);
    expect(ranked[0]).toMatchObject({
      url: "https://instagram.com/reel/B2/",
      views: 5_000,
      likes: 0,
      comments: 0,
      caption: "Caption B2",
    });
    expect(ranked[0]?.postedAt?.toISOString()).toBe("2026-09-01T10:00:00.000Z");
  });

  it("cuts long captions and drops repeated links", () => {
    const ranked = rankVideos(
      [
        media("A1", { caption: "x".repeat(COMPETITOR_CAPTION_MAX_LENGTH + 50), viewCount: 2 }),
        media("A2", { permalink: "https://instagram.com/reel/A1/", viewCount: 1 }),
      ],
      10,
    );
    expect(ranked).toHaveLength(1);
    expect(ranked[0]?.caption).toHaveLength(COMPETITOR_CAPTION_MAX_LENGTH);
  });
});

describe("linkedVideos", () => {
  it("keeps the order of the links and drops repeats", () => {
    const videos = linkedVideos(
      [
        "https://www.facebook.com/reel/123",
        "https://facebook.com/nasa/videos/456/",
        "https://m.facebook.com/reel/123",
      ],
      "facebook",
    );
    expect(videos.map((video) => video.url)).toEqual([
      "https://facebook.com/reel/123",
      "https://facebook.com/nasa/videos/456/",
    ]);
  });

  it("refuses links that are not public videos of the platform with 422", () => {
    try {
      linkedVideos(
        ["https://instagram.com/reel/abc/", "https://facebook.com/nasa", "not a link at all"],
        "facebook",
      );
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ status: 422, code: "invalid_link" });
      const details = (error as { details: { path: string }[] }).details;
      expect(details.map((issue) => issue.path)).toEqual(["links.0", "links.1", "links.2"]);
    }
  });
});

describe("scanVideoTitle", () => {
  it("starts with the handle and the first words of the caption", () => {
    expect(scanVideoTitle("nasa", 1, "  Landing   on Mars\nin 7 minutes ")).toBe(
      "@nasa · Landing on Mars in 7 minutes",
    );
    expect(scanVideoTitle("nasa", 3, null)).toBe("@nasa video 3");
    expect(scanVideoTitle("nasa", 2, "y".repeat(100))).toBe(`@nasa · ${"y".repeat(60)}…`);
  });
});

describe("insightsMarkdown", () => {
  it("renders every part, leaving out empty lists", () => {
    const markdown = insightsMarkdown({
      positioning: "Space science for everyone.",
      topics: ["Mars"],
      hookPatterns: [],
      formats: ["Talking head"],
      lengthAndPacing: "Short and quick.",
      whatWorks: ["Footage first"],
      opportunities: [],
      recommendations: ["Open on the picture"],
    });
    expect(markdown).toContain("**Positioning.** Space science for everyone.");
    expect(markdown).toContain("### Topics\n\n- Mars");
    expect(markdown).not.toContain("Hook patterns");
    expect(markdown).not.toContain("Posting cadence");
    expect(markdown).toContain("### Recommendations\n\n- Open on the picture");
  });
});

describe("businessDiscoveryFields", () => {
  it("builds the nested fields expression, with the cursor and without views when asked", () => {
    expect(businessDiscoveryFields("nasa", { viewCount: true })).toBe(
      "business_discovery.username(nasa){username,name,followers_count,media_count," +
        "media.limit(50){id,media_type,media_product_type,caption,like_count,comments_count," +
        "view_count,timestamp,permalink}}",
    );
    const next = businessDiscoveryFields("nasa", { after: "QVFIUk", viewCount: false });
    expect(next).toContain("media.limit(50).after(QVFIUk){");
    expect(next).not.toContain("view_count");
  });
});

interface Call {
  url: URL;
  headers: Headers;
}

/** A Graph client whose fetch answers from `replies` in order and records every call. */
function fakeGraph(replies: { status?: number; body: unknown }[]) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (input, init) => {
    calls.push({ url: new URL(input), headers: new Headers(init.headers) });
    const reply = replies.shift();
    if (reply === undefined) {
      throw new Error("unexpected Graph call");
    }
    return new Response(JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };
  const client = createGraphClient({
    baseUrl: GRAPH_ORIGIN,
    version: GRAPH_VERSION,
    appSecret: fakeCredential("secret"),
    fetch,
    sleep: async () => {},
  });
  return { client, calls };
}

function rawMedia(id: string, views?: number) {
  return {
    id,
    media_type: "VIDEO",
    media_product_type: "REELS",
    caption: `Caption ${id}`,
    like_count: 3,
    comments_count: 1,
    ...(views === undefined ? {} : { view_count: views }),
    timestamp: "2026-09-01T10:00:00+0000",
    permalink: `https://www.instagram.com/reel/${id}/`,
  };
}

function page(items: unknown[], after?: string) {
  return {
    business_discovery: {
      username: "nasa",
      name: "NASA",
      followers_count: 1_000,
      media_count: 400,
      media: {
        data: items,
        paging: after === undefined ? {} : { cursors: { after }, next: "https://graph.example" },
      },
    },
    id: "1789",
  };
}

describe("businessDiscovery", () => {
  it("follows the cursor up to the post limit with the token and its proof", async () => {
    const token = fakeCredential("token");
    const { client, calls } = fakeGraph([
      { body: page([rawMedia("A1", 10), rawMedia("A2", 20)], "CURSOR1") },
      { body: page([rawMedia("B1", 30), rawMedia("B2", 40)], "CURSOR2") },
    ]);
    const result = await businessDiscovery(client, {
      igUserId: "1789",
      handle: "nasa",
      accessToken: token,
      maxPosts: 3,
    });
    expect(result).toMatchObject({
      username: "nasa",
      name: "NASA",
      followersCount: 1_000,
      mediaCount: 400,
      viewCounts: true,
    });
    expect(result.media.map((item) => item.id)).toEqual(["A1", "A2", "B1"]);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url.pathname).toBe(`/${GRAPH_VERSION}/1789`);
    expect(calls[0]?.headers.get("authorization")).toBe(`Bearer ${token}`);
    expect(calls[0]?.url.searchParams.get("appsecret_proof")).toMatch(/^[0-9a-f]{64}$/);
    expect(calls[0]?.url.searchParams.get("fields")).not.toContain(".after(");
    expect(calls[1]?.url.searchParams.get("fields")).toContain(".after(CURSOR1)");
    expect(calls[0]?.url.toString()).not.toContain(token);
  });

  it("stops after the post limit's pages even when the cursor goes on", async () => {
    const replies = Array.from({ length: 4 }, (_, index) => ({
      body: page(
        Array.from({ length: 50 }, (_, item) => rawMedia(`P${index}x${item}`, item)),
        `C${index}`,
      ),
    }));
    const { client, calls } = fakeGraph(replies);
    const result = await businessDiscovery(client, {
      igUserId: "1789",
      handle: "nasa",
      accessToken: fakeCredential("token"),
      maxPosts: 200,
    });
    expect(result.media).toHaveLength(200);
    expect(calls).toHaveLength(4);
  });

  it("asks again without view_count when the API refuses the field", async () => {
    const { client, calls } = fakeGraph([
      { status: 400, body: graphError(100, "Tried accessing nonexisting field (view_count)") },
      { body: page([rawMedia("A1")], "CURSOR1") },
      { body: page([rawMedia("B1")]) },
    ]);
    const result = await businessDiscovery(client, {
      igUserId: "1789",
      handle: "nasa",
      accessToken: fakeCredential("token"),
      maxPosts: 200,
    });
    expect(result.viewCounts).toBe(false);
    expect(result.media.map((item) => [item.id, item.viewCount])).toEqual([
      ["A1", null],
      ["B1", null],
    ]);
    const fields = calls.map((call) => call.url.searchParams.get("fields") ?? "");
    expect(fields[0]).toContain("view_count");
    expect(fields[1]).not.toContain("view_count");
    expect(fields[2]).not.toContain("view_count");
    expect(fields[2]).toContain(".after(CURSOR1)");
  });

  it("throws the not-found subcode for an account that is not professional", async () => {
    const { client, calls } = fakeGraph([
      {
        status: 400,
        body: graphError(110, "Invalid user id", BUSINESS_DISCOVERY_NOT_FOUND_SUBCODE),
      },
    ]);
    const failure = await businessDiscovery(client, {
      igUserId: "1789",
      handle: "someone",
      accessToken: fakeCredential("token"),
      maxPosts: 200,
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(MetaGraphError);
    expect((failure as MetaGraphError).fields.subcode).toBe(BUSINESS_DISCOVERY_NOT_FOUND_SUBCODE);
    expect(calls).toHaveLength(1);
  });

  it("ignores a cursor with characters a fields expression must not hold", async () => {
    const { client, calls } = fakeGraph([{ body: page([rawMedia("A1", 1)], "bad){cursor") }]);
    const result = await businessDiscovery(client, {
      igUserId: "1789",
      handle: "nasa",
      accessToken: fakeCredential("token"),
      maxPosts: 200,
    });
    expect(result.media).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });
});
