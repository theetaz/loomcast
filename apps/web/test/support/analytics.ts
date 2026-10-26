import type { ContentItem, Platform, PostMetrics } from "@loomcast/contracts";
import { type MockLivePost, mockLivePost } from "@/mocks/analytics";
import { mockContentItem, mockSeries } from "@/mocks/content";
import { createMockDb, MOCK_USER, type MockDb, mockWorkspace } from "@/mocks/db";
import { onlineStudio } from "./kb";

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

/** A capture `hours` after `publishedAt`; counts default to a share of `views`. */
export function capture(
  publishedAt: string,
  hours: number,
  views: number,
  overrides: Partial<PostMetrics> = {},
): PostMetrics {
  return {
    capturedAt: new Date(Date.parse(publishedAt) + hours * HOUR_MS).toISOString(),
    views,
    likes: Math.round(views * 0.05),
    comments: Math.round(views * 0.01),
    shares: Math.round(views * 0.01),
    saves: null,
    reach: Math.round(views * 0.8),
    avgWatchMs: null,
    ...overrides,
  };
}

/** Noon UTC `days` before today, so a post stays inside "last 30 days" all day. */
export function daysAgo(days: number, now = Date.now()): string {
  const date = new Date(now - days * DAY_MS);
  date.setUTCHours(12, 0, 0, 0);
  return date.toISOString();
}

/**
 * A signed-in db with one workspace and series and two published videos:
 * - `borrowing`, 10 days ago, on Instagram (four captures, 4,000 views, 12.5 s watch time) and
 *   Threads (two captures, 1,200 views, no watch time);
 * - `moves`, 3 days ago, on Instagram (2,500 views, 10 s) and Facebook (900 views, 8 s).
 * Totals: 4 posts, 8,600 views, median 1,850.
 */
export function analyticsSetup() {
  const workspace = mockWorkspace({ name: "Rust in 60 seconds", slug: "rust-in-60-seconds" });
  const series = mockSeries({ workspaceId: workspace.id, name: "Ownership basics" });
  const items: ContentItem[] = [];
  const versions: ReturnType<typeof mockContentItem>["versions"] = [];
  const published = (title: string, publishedAt: string) => {
    const created = mockContentItem({
      workspaceId: workspace.id,
      seriesId: series.id,
      title,
      state: "published",
      versionNo: 5,
      createdBy: MOCK_USER.id,
      targetAt: publishedAt,
      updatedAt: publishedAt,
    });
    items.push(created.item);
    versions.push(...created.versions);
    return created.item;
  };

  const borrowingAt = daysAgo(10);
  const movesAt = daysAgo(3);
  const borrowing = published("Borrowing basics", borrowingAt);
  const moves = published("Moves explained", movesAt);

  const live = (
    item: ContentItem,
    platform: Platform,
    publishedAt: string,
    history: PostMetrics[],
  ): MockLivePost => mockLivePost({ item, platform, publishedAt, history });

  // The second channel goes live five minutes after the first, so the order is fixed.
  const later = (at: string) => new Date(Date.parse(at) + 5 * 60_000).toISOString();
  const posts = {
    borrowingInstagram: live(borrowing, "instagram", borrowingAt, [
      capture(borrowingAt, 1, 300, { avgWatchMs: 13_000 }),
      capture(borrowingAt, 24, 2_000, { avgWatchMs: 12_800 }),
      capture(borrowingAt, 72, 3_500, { avgWatchMs: 12_600 }),
      capture(borrowingAt, 168, 4_000, { avgWatchMs: 12_500, saves: 60 }),
    ]),
    borrowingThreads: live(borrowing, "threads", later(borrowingAt), [
      capture(borrowingAt, 1, 200),
      capture(borrowingAt, 72, 1_200),
    ]),
    movesInstagram: live(moves, "instagram", movesAt, [
      capture(movesAt, 6, 1_000, { avgWatchMs: 10_500 }),
      capture(movesAt, 72, 2_500, { avgWatchMs: 10_000 }),
    ]),
    movesFacebook: live(moves, "facebook", later(movesAt), [
      capture(movesAt, 24, 900, { avgWatchMs: 8_000 }),
    ]),
  };

  const draft = mockContentItem({
    workspaceId: workspace.id,
    seriesId: series.id,
    title: "Lifetimes are scopes",
    state: "review",
    versionNo: 5,
  });

  const db: MockDb = createMockDb({
    signedIn: true,
    workspaces: [workspace],
    devices: [onlineStudio()],
    series: [series],
    contentItems: [...items, draft.item],
    contentVersions: [...versions, ...draft.versions],
    livePosts: Object.values(posts),
  });
  return { db, workspace, series, items: { borrowing, moves, draft: draft.item }, posts };
}
