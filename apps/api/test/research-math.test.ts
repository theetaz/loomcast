import { describe, expect, it } from "vitest";
import {
  type LeaderboardVideo,
  median,
  outlierScore,
  topicLeaderboard,
} from "../src/modules/research";

const NOW = new Date("2026-10-19T00:00:00.000Z");
const DAY_MS = 24 * 60 * 60_000;

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * DAY_MS);
}

let counter = 0;
function video(values: Partial<LeaderboardVideo> & { accountId: string }): LeaderboardVideo {
  counter += 1;
  return {
    id: `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`,
    handle: values.accountId,
    url: null,
    topic: "ai agents",
    views: 1_000,
    outlierScore: 1,
    at: daysAgo(10),
    ...values,
  };
}

const options = { now: NOW, windowDays: 90, minHitCreators: 0, limit: 25 };

describe("median", () => {
  it("takes the middle value, averaging the two middle ones of an even list", () => {
    expect(median([])).toBeNull();
    expect(median([7])).toBe(7);
    expect(median([9, 1, 5])).toBe(5);
    expect(median([1, 2, 3, 10])).toBe(3);
    expect(median([1, 2])).toBe(2);
  });
});

describe("outlierScore", () => {
  it("divides views by the median, two decimals, null when unknown", () => {
    expect(outlierScore(5_000, 1_000)).toBe(5);
    expect(outlierScore(1_234, 1_000)).toBe(1.23);
    expect(outlierScore(null, 1_000)).toBeNull();
    expect(outlierScore(10, null)).toBeNull();
    expect(outlierScore(10, 0)).toBeNull();
  });
});

describe("topicLeaderboard", () => {
  it("summarises each topic and ranks proven topics first", () => {
    const videos = [
      // Three creators hit with "ai agents": proven.
      video({ accountId: "a", views: 50_000, outlierScore: 10, at: daysAgo(5) }),
      video({ accountId: "a", views: 2_000, outlierScore: 1, at: daysAgo(40) }),
      video({ accountId: "b", views: 30_000, outlierScore: 6, at: daysAgo(50) }),
      video({ accountId: "c", views: 9_000, outlierScore: 5, at: daysAgo(60) }),
      // One creator's lucky hit.
      video({ accountId: "d", topic: "rust", views: 900_000, outlierScore: 40, at: daysAgo(2) }),
      // Untagged and out-of-window videos.
      video({ accountId: "e", topic: null }),
      video({ accountId: "f", topic: "ai agents", outlierScore: 99, at: daysAgo(120) }),
    ];
    const board = topicLeaderboard(videos, [], options);

    expect(board.untagged).toBe(1);
    expect(board.topics.map((topic) => topic.topic)).toEqual(["ai agents", "rust"]);
    const [agents, rust] = board.topics;
    expect(agents).toMatchObject({
      videos: 4,
      creators: 3,
      hitCreators: 3,
      maxViews: 50_000,
      medianViews: 19_500,
      bestOutlier: 10,
      lastHitAt: daysAgo(5).toISOString(),
      saturation: 1,
      proven: true,
      own: null,
    });
    // 2 x 3 + log10(19,501) + 10 / 5 - 0.25 x 1
    expect(agents?.topicScore).toBe(Math.round((6 + Math.log10(19_501) + 2 - 0.25) * 100) / 100);
    expect(agents?.examples.map((example) => example.outlierScore)).toEqual([10, 6, 5]);
    expect(rust).toMatchObject({ hitCreators: 1, proven: false, bestOutlier: 40 });
  });

  it("leaves out topics with too few hit creators and keeps to the limit", () => {
    const videos = [
      video({ accountId: "a", topic: "one", outlierScore: 8 }),
      video({ accountId: "b", topic: "one", outlierScore: 8 }),
      video({ accountId: "a", topic: "two", outlierScore: 8 }),
      video({ accountId: "a", topic: "three", outlierScore: 1 }),
    ];
    expect(
      topicLeaderboard(videos, [], { ...options, minHitCreators: 2 }).topics.map((t) => t.topic),
    ).toEqual(["one"]);
    expect(topicLeaderboard(videos, [], { ...options, limit: 2 }).topics).toHaveLength(2);
  });

  it("counts a creator once however many hits it has, and unknown scores as no hit", () => {
    const board = topicLeaderboard(
      [
        video({ accountId: "a", outlierScore: 9 }),
        video({ accountId: "a", outlierScore: 7 }),
        video({ accountId: "b", outlierScore: null, views: null }),
      ],
      [],
      options,
    );
    expect(board.topics[0]).toMatchObject({
      videos: 3,
      creators: 2,
      hitCreators: 1,
      medianViews: 1_000,
    });
  });

  it("joins the workspace's own posts on the same topic", () => {
    const board = topicLeaderboard(
      [video({ accountId: "a" })],
      [
        { topic: "ai agents", views: 300 },
        { topic: "ai agents", views: 100 },
        { topic: "ai agents", views: null },
        { topic: "rust", views: 5 },
      ],
      options,
    );
    expect(board.topics[0]?.own).toEqual({
      posts: 3,
      measured: 2,
      medianViews: 200,
      maxViews: 300,
    });
  });
});
