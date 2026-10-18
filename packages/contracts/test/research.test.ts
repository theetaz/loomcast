import { describe, expect, it } from "vitest";
import {
  analyticsTools,
  normalizeResearchHandle,
  normalizeTopic,
  RESEARCH_LIMITS,
  researchExternalIdFromUrl,
  researchTools,
  researchTopicScore,
} from "../src";

describe("normalizeTopic", () => {
  it("folds case, punctuation and spacing so variants group together", () => {
    expect(normalizeTopic("AI Agents!")).toBe("ai agents");
    expect(normalizeTopic(" ai-agents ")).toBe("ai agents");
    expect(normalizeTopic("ai   agents")).toBe("ai agents");
    expect(normalizeTopic("Ｃｌｏｕｄ costs")).toBe("cloud costs");
    expect(normalizeTopic("Café ☕ tips")).toBe("café tips");
  });

  it("returns null when nothing is left and cuts long topics", () => {
    expect(normalizeTopic("  !!! ")).toBeNull();
    expect(normalizeTopic("a".repeat(200))).toHaveLength(RESEARCH_LIMITS.topic);
  });
});

describe("normalizeResearchHandle", () => {
  it("drops the @, lowercases and refuses characters platforms do not allow", () => {
    expect(normalizeResearchHandle(" @FireShip.io ")).toBe("fireship.io");
    expect(normalizeResearchHandle("@@dev_tips-1")).toBe("dev_tips-1");
    expect(normalizeResearchHandle("two words")).toBeNull();
    expect(normalizeResearchHandle("@")).toBeNull();
  });
});

describe("researchExternalIdFromUrl", () => {
  it("reads the platform's id of a video from its link", () => {
    expect(researchExternalIdFromUrl("instagram", "https://instagram.com/reel/DAbc_12-x/")).toBe(
      "DAbc_12-x",
    );
    expect(researchExternalIdFromUrl("instagram", "https://instagram.com/nasa/p/CODE1/")).toBe(
      "CODE1",
    );
    expect(
      researchExternalIdFromUrl("tiktok", "https://tiktok.com/@dev/video/7301234567890123456"),
    ).toBe("7301234567890123456");
    expect(researchExternalIdFromUrl("youtube", "https://youtube.com/shorts/dQw4w9WgXcQ")).toBe(
      "dQw4w9WgXcQ",
    );
    expect(
      researchExternalIdFromUrl("youtube", "https://youtube.com/watch?v=dQw4w9WgXcQ&t=1"),
    ).toBe("dQw4w9WgXcQ");
    expect(researchExternalIdFromUrl("youtube", "https://youtu.be/dQw4w9WgXcQ")).toBe(
      "dQw4w9WgXcQ",
    );
    expect(researchExternalIdFromUrl("facebook", "https://facebook.com/reel/123456")).toBe(
      "123456",
    );
    expect(researchExternalIdFromUrl("facebook", "https://facebook.com/nasa/videos/789/")).toBe(
      "789",
    );
    expect(researchExternalIdFromUrl("threads", "https://threads.net/@dev/post/C0de_1")).toBe(
      "C0de_1",
    );
    expect(researchExternalIdFromUrl("instagram", "https://instagram.com/nasa/")).toBeNull();
  });
});

describe("researchTopicScore", () => {
  it("rewards hit creators most and takes a little away for crowded topics", () => {
    expect(
      researchTopicScore({ hitCreators: 3, medianViews: 99_999, bestOutlier: 12, saturation: 4 }),
    ).toBe(6 + 5 + 2.4 - 1);
    expect(
      researchTopicScore({ hitCreators: 0, medianViews: null, bestOutlier: null, saturation: 0 }),
    ).toBe(0);
    // The outlier bonus is capped at 20.
    expect(
      researchTopicScore({ hitCreators: 1, medianViews: 0, bestOutlier: 400, saturation: 0 }),
    ).toBe(2 + 4);
  });
});

describe("research tools", () => {
  it("keep writes to the owner and open reads to every token with the workspace", () => {
    for (const tool of Object.values(researchTools)) {
      if (tool.scope === "mcp:read") {
        expect([tool.name, tool.jobTokens]).toEqual([tool.name, "allow"]);
      } else {
        expect([tool.name, tool.scope, tool.jobTokens]).toEqual([tool.name, "mcp:admin", "deny"]);
        expect(tool.description.startsWith("Owner only.")).toBe(true);
      }
    }
    for (const tool of Object.values(analyticsTools)) {
      expect([tool.name, tool.scope]).toEqual([tool.name, "mcp:read"]);
    }
  });

  it("warns that third-party text is untrusted wherever it is returned or written", () => {
    for (const name of ["research.list_videos", "research.tag_video"] as const) {
      expect(researchTools[name].description).toContain("untrusted third-party text");
    }
  });

  it("needs a link or an id for every added video", () => {
    const { input } = researchTools["research.add_videos"];
    const video = { platform: "instagram", handle: "@nasa", views: 10 };
    expect(input.safeParse({ workspace: "unfolded", videos: [video] }).success).toBe(false);
    expect(
      input.safeParse({
        workspace: "unfolded",
        videos: [{ ...video, url: "https://instagram.com/reel/abc/" }],
      }).success,
    ).toBe(true);
    expect(
      input.safeParse({ workspace: "unfolded", videos: [{ ...video, externalId: "abc" }] }).success,
    ).toBe(true);
    expect(input.safeParse({ workspace: "unfolded", videos: [] }).success).toBe(false);
  });

  it("needs at least one label to tag videos", () => {
    const { input } = researchTools["research.tag_video"];
    const videoIds = ["00000000-0000-4000-8000-000000000001"];
    expect(input.safeParse({ videoIds }).success).toBe(false);
    expect(input.safeParse({ videoIds, topic: "ai agents" }).success).toBe(true);
    expect(input.safeParse({ videoIds: [], topic: "ai agents" }).success).toBe(false);
  });
});
