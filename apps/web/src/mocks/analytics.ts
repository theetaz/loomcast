import {
  ANALYTICS_TOP_POSTS,
  type AnalyticsOverview,
  AnalyticsOverviewQuerySchema,
  type ApiError,
  aggregatePosts,
  type Channel,
  type ContentItem,
  type ContentVersion,
  type DailyViews,
  INSIGHTS_SCHEDULE_OFFSETS_MS,
  type ItemAnalytics,
  insightsSchedule,
  PLATFORMS,
  type Platform,
  type PostAnalytics,
  type PostMetrics,
  type PostPerformance,
  routes,
  type Series,
  SeriesAnalyticsQuerySchema,
} from "@loomcast/contracts";
import { HttpResponse, http } from "msw";
import { mockPost } from "./calendar";
import { mockContentItem } from "./content";
import { type MockDb, mockId, publish } from "./db";

// Analytics of live posts: published, never dry-run. Each post keeps every capture of its insights,
// oldest first, and the API answers from the latest one, as the real one does.

/** A live post and its captures, oldest first. `history` is empty until the first capture. */
export interface MockLivePost {
  post: Omit<PostPerformance, "metrics">;
  history: PostMetrics[];
}

const path = (name: keyof typeof routes) => `*${routes[name].path}`;

function apiError(status: number, code: string, message: string) {
  return HttpResponse.json<ApiError>({ error: { code, message } }, { status });
}

const unauthorized = () => apiError(401, "unauthorized", "Sign in to continue.");

function performance(live: MockLivePost): PostPerformance {
  return { ...live.post, metrics: live.history.at(-1) ?? null };
}

function totalsOf(posts: readonly MockLivePost[]) {
  return aggregatePosts(posts.map((live) => live.history.at(-1) ?? null));
}

function byPublishedAt(a: MockLivePost, b: MockLivePost): number {
  return (
    a.post.publishedAt.localeCompare(b.post.publishedAt) ||
    a.post.postId.localeCompare(b.post.postId)
  );
}

/** The next scheduled capture after the latest one, or null once the schedule has run out. */
export function nextCaptureAt(live: MockLivePost, now = Date.now()): string | null {
  const last = live.history.at(-1);
  const after = last ? Date.parse(last.capturedAt) : now;
  const next = insightsSchedule(live.post.publishedAt).find((time) => time.getTime() > after);
  return next ? next.toISOString() : null;
}

function postAnalytics(live: MockLivePost): PostAnalytics {
  return { post: performance(live), history: live.history, nextCaptureAt: nextCaptureAt(live) };
}

function inRange(live: MockLivePost, from?: string, to?: string): boolean {
  const time = Date.parse(live.post.publishedAt);
  if (from !== undefined && time < Date.parse(from)) return false;
  if (to !== undefined && time >= Date.parse(to)) return false;
  return true;
}

/** The overview of `posts`, following `AnalyticsOverviewSchema`. */
export function overviewOf(
  posts: readonly MockLivePost[],
  from: string,
  to: string,
): AnalyticsOverview {
  const platforms = PLATFORMS.flatMap((platform) => {
    const own = posts.filter((live) => live.post.platform === platform);
    return own.length > 0 ? [{ platform, totals: totalsOf(own) }] : [];
  });

  const days = new Map<string, DailyViews>();
  for (const live of posts) {
    const date = live.post.publishedAt.slice(0, 10);
    const key = `${date}|${live.post.platform}`;
    const row = days.get(key) ?? { date, platform: live.post.platform, posts: 0, views: 0 };
    row.posts += 1;
    row.views += live.history.at(-1)?.views ?? 0;
    days.set(key, row);
  }
  const daily = [...days.values()].sort(
    (a, b) =>
      a.date.localeCompare(b.date) || PLATFORMS.indexOf(a.platform) - PLATFORMS.indexOf(b.platform),
  );

  const topPosts = posts
    .map(performance)
    .sort((a, b) => (b.metrics?.views ?? -1) - (a.metrics?.views ?? -1))
    .slice(0, ANALYTICS_TOP_POSTS);

  return { from, to, totals: totalsOf(posts), platforms, daily, topPosts };
}

function searchParams(request: Request): Record<string, string> {
  return Object.fromEntries(new URL(request.url).searchParams);
}

export function createAnalyticsHandlers(db: MockDb) {
  return [
    http.get(path("analytics.post"), ({ params }) => {
      if (!db.signedIn) return unauthorized();
      const live = db.livePosts.find((entry) => entry.post.postId === params.id);
      if (!live) return apiError(404, "not_found", "No live post has that id.");
      return HttpResponse.json(postAnalytics(live));
    }),

    http.get(path("analytics.item"), ({ params }) => {
      if (!db.signedIn) return unauthorized();
      const itemId = String(params.id);
      if (!db.contentItems.some((item) => item.id === itemId)) {
        return apiError(404, "not_found", "No content item has that id.");
      }
      const posts = db.livePosts.filter((live) => live.post.itemId === itemId).sort(byPublishedAt);
      const body: ItemAnalytics = {
        itemId,
        totals: totalsOf(posts),
        posts: posts.map(postAnalytics),
      };
      return HttpResponse.json(body);
    }),

    http.get(path("analytics.series"), ({ params, request }) => {
      if (!db.signedIn) return unauthorized();
      const seriesId = String(params.id);
      if (!db.series.some((series) => series.id === seriesId)) {
        return apiError(404, "not_found", "No series has that id.");
      }
      const query = SeriesAnalyticsQuerySchema.safeParse(searchParams(request));
      if (!query.success) return apiError(400, "validation_failed", "Check the range.");
      const posts = db.livePosts
        .filter((live) => live.post.seriesId === seriesId)
        .filter((live) => inRange(live, query.data.from, query.data.to))
        .sort(byPublishedAt);
      return HttpResponse.json({
        seriesId,
        totals: totalsOf(posts),
        posts: posts.map(performance),
      });
    }),

    http.get(path("analytics.overview"), ({ request }) => {
      if (!db.signedIn) return unauthorized();
      const query = AnalyticsOverviewQuerySchema.safeParse(searchParams(request));
      if (!query.success) return apiError(400, "validation_failed", "Check the range.");
      const { from, to, projectId } = query.data;
      const posts = db.livePosts
        .filter((live) => projectId === undefined || live.post.projectId === projectId)
        .filter((live) => inRange(live, from, to))
        .sort(byPublishedAt);
      return HttpResponse.json(overviewOf(posts, from, to));
    }),
  ];
}

// Builders --------------------------------------------------------------------------------------

/** A small deterministic generator, so the demo numbers are the same on every reload. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** How much of a post's final views each scheduled capture has seen. */
const CAPTURE_SHARE = [0.07, 0.28, 0.58, 0.8, 0.92, 0.97, 1] as const;

/** Whether the platform reports saves and watch time. */
const REPORTS: Record<Platform, { saves: boolean; watch: boolean }> = {
  facebook: { saves: false, watch: true },
  instagram: { saves: true, watch: true },
  threads: { saves: false, watch: false },
  x: { saves: true, watch: false },
};

export interface MockMetricsOptions {
  platform: Platform;
  publishedAt: string;
  /** The views the last scheduled capture would see. */
  finalViews: number;
  now?: number;
  seed?: number;
}

/** Captures on the insights schedule up to `now`, growing towards `finalViews`. */
export function mockMetricsHistory({
  platform,
  publishedAt,
  finalViews,
  now = Date.now(),
  seed = 1,
}: MockMetricsOptions): PostMetrics[] {
  const next = random(seed);
  const likeRate = 0.035 + next() * 0.04;
  const commentRate = 0.002 + next() * 0.004;
  const shareRate = 0.003 + next() * 0.008;
  const saveRate = 0.004 + next() * 0.01;
  const watchMs = 9_000 + Math.round(next() * 9_000);
  const reports = REPORTS[platform];
  const start = Date.parse(publishedAt);

  return INSIGHTS_SCHEDULE_OFFSETS_MS.flatMap((offset, index) => {
    if (start + offset > now) return [];
    const views = Math.round(finalViews * (CAPTURE_SHARE[index] ?? 1));
    return [
      {
        capturedAt: new Date(start + offset + 90_000).toISOString(),
        views,
        likes: Math.round(views * likeRate),
        comments: Math.round(views * commentRate),
        shares: Math.round(views * shareRate),
        saves: reports.saves ? Math.round(views * saveRate) : null,
        reach: Math.round(views * 0.82),
        avgWatchMs: reports.watch ? watchMs - index * 250 : null,
      },
    ];
  });
}

const PERMALINKS: Record<Platform, (code: string) => string> = {
  facebook: (code) => `https://www.facebook.com/reel/${code}`,
  instagram: (code) => `https://www.instagram.com/reel/${code}/`,
  threads: (code) => `https://www.threads.net/@loomcast/post/${code}`,
  x: (code) => `https://x.com/loomcast/status/${code}`,
};

export interface MockLivePostOptions {
  item: Pick<ContentItem, "id" | "projectId" | "seriesId" | "title">;
  platform: Platform;
  publishedAt: string;
  channelId?: string;
  history?: PostMetrics[];
}

export function mockLivePost({
  item,
  platform,
  publishedAt,
  channelId = mockId(),
  history = [],
}: MockLivePostOptions): MockLivePost {
  const postId = mockId();
  return {
    post: {
      postId,
      itemId: item.id,
      projectId: item.projectId,
      seriesId: item.seriesId,
      channelId,
      platform,
      title: item.title,
      permalink: PERMALINKS[platform](postId.replaceAll("-", "").slice(0, 11)),
      publishedAt,
    },
    history,
  };
}

/**
 * Stores a new capture of a live post and publishes `post.metrics.updated`, as the insights task
 * does. Missing counts copy the latest capture.
 */
export function addMetricsCapture(
  db: MockDb,
  postId: string,
  changes: Partial<PostMetrics> = {},
): PostMetrics {
  const live = db.livePosts.find((entry) => entry.post.postId === postId);
  if (!live) throw new Error("No such live post.");
  const previous = live.history.at(-1);
  const metrics: PostMetrics = {
    views: null,
    likes: null,
    comments: null,
    shares: null,
    saves: null,
    reach: null,
    avgWatchMs: null,
    ...previous,
    capturedAt: new Date().toISOString(),
    ...changes,
  };
  live.history.push(metrics);
  const { itemId, projectId, channelId, platform } = live.post;
  publish(db, {
    type: "post.metrics.updated",
    payload: { postId, itemId, projectId, channelId, platform, metrics },
  });
  return metrics;
}

// Demo data -------------------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60_000;

const BACK_CATALOGUE: Record<string, string[]> = {
  "Ownership basics": [
    "Ownership in one diagram",
    "Why moves are cheap",
    "Borrowing is a read lock",
    "Mutable borrows, one at a time",
    "Drop runs when you think it does",
    "Copy types and the trap they set",
    "Rc is shared ownership, not a fix",
    "Cell and RefCell without fear",
    "The two rules behind every borrow error",
  ],
  "Error handling": [
    "panic! is for bugs",
    "Option before Result",
    "map_err in the wild",
    "Errors as values, a 30-second tour",
    "Custom error types in nine lines",
    "When to box an error",
  ],
  "Agent patterns": [
    "Give the agent a budget",
    "Tool calls are API calls",
    "Retries that do not loop",
    "Keep the transcript short",
    "Agents need tests too",
  ],
};

/** The platforms a project's demo channels publish to. */
const DEMO_PLATFORMS: Platform[][] = [
  ["instagram", "facebook", "threads"],
  ["instagram", "threads"],
];

/** How a platform's audience compares in the demo: Instagram leads, Threads trails. */
const PLATFORM_REACH: Record<Platform, number> = {
  instagram: 1,
  facebook: 0.55,
  threads: 0.3,
  x: 0.4,
};

/** A channel a demo post goes to: one of the calendar's channels, or a stand-in id without one. */
interface DemoChannel {
  id: string;
  platform: Platform;
  channel: Channel | null;
}

/**
 * Mock mode: live posts for the demo's published items, plus a back catalogue of published videos
 * over the last five months, so the analytics have trends to show. The newest video went live
 * minutes ago and has no insights yet. Run after `seedCalendarDemo`: posts go to the channels the
 * calendar links to each series, every live post is also a published (not dry-run) post in
 * `db.posts` with the same id, and items the calendar already posted (dry runs, never measured)
 * are left alone.
 */
export function seedAnalyticsDemo(db: MockDb, now = Date.now()) {
  const next = random(20261013);
  const standIns = new Map<string, string>();
  const standIn = (projectId: string, platform: Platform): DemoChannel => {
    const key = `${projectId}|${platform}`;
    const id = standIns.get(key) ?? mockId();
    standIns.set(key, id);
    return { id, platform, channel: null };
  };
  const channelsFor = (item: ContentItem): DemoChannel[] => {
    const links = db.seriesChannels.find((entry) => entry.seriesId === item.seriesId)?.channels;
    const linked = (links ?? []).flatMap((link) => {
      const channel = db.channels.find((entry) => entry.id === link.channelId);
      return channel ? [{ id: channel.id, platform: channel.platform, channel }] : [];
    });
    if (linked.length > 0) return linked;
    const index = Math.max(
      0,
      db.projects.findIndex((project) => project.id === item.projectId),
    );
    const platforms = DEMO_PLATFORMS[index % DEMO_PLATFORMS.length] ?? [];
    return platforms.map((platform) => standIn(item.projectId, platform));
  };

  const addLivePost = (
    item: ContentItem,
    target: DemoChannel,
    at: string,
    history: PostMetrics[],
  ) => {
    const live = mockLivePost({
      item,
      platform: target.platform,
      publishedAt: at,
      channelId: target.id,
      history,
    });
    db.livePosts.push(live);
    if (target.channel) {
      db.posts.push(
        mockPost({
          id: live.post.postId,
          item,
          channel: target.channel,
          scheduledAt: at,
          status: "published",
          dryRun: false,
          externalId: live.post.postId.replaceAll("-", "").slice(0, 15),
          permalink: live.post.permalink,
          publishedAt: at,
          createdAt: new Date(Date.parse(at) - DAY_MS).toISOString(),
        }),
      );
    }
  };

  const goLive = (item: ContentItem, publishedAt: string, baseViews: number) => {
    channelsFor(item).forEach((target, index) => {
      const at = new Date(Date.parse(publishedAt) + index * 7 * 60_000).toISOString();
      addLivePost(
        item,
        target,
        at,
        mockMetricsHistory({
          platform: target.platform,
          publishedAt: at,
          finalViews: Math.round(
            baseViews * PLATFORM_REACH[target.platform] * (0.7 + next() * 0.6),
          ),
          now,
          seed: Math.floor(next() * 1e9),
        }),
      );
    });
  };

  const publishedItem = (series: Series, title: string, publishedAt: string) => {
    const { item, versions } = mockContentItem({
      projectId: series.projectId,
      seriesId: series.id,
      title,
      state: "published",
      versionNo: 5,
      createdBy: db.user.id,
      createdAt: new Date(Date.parse(publishedAt) - 3 * DAY_MS).toISOString(),
      updatedAt: publishedAt,
      targetAt: publishedAt,
    });
    db.contentItems.push(item);
    db.contentVersions.push(...(versions as ContentVersion[]));
    return item;
  };

  for (const series of db.series) {
    const titles = BACK_CATALOGUE[series.name] ?? [];
    titles.forEach((title, index) => {
      const daysAgo = 150 - index * Math.floor(140 / Math.max(1, titles.length)) - next() * 4;
      const publishedAt = new Date(now - daysAgo * DAY_MS);
      publishedAt.setUTCHours(17, 0, 0, 0);
      // Later videos in a series find a bigger audience.
      const base = 2_400 + index * 900 + next() * 2_600;
      goLive(
        publishedItem(series, title, publishedAt.toISOString()),
        publishedAt.toISOString(),
        base,
      );
    });
  }

  for (const item of db.contentItems) {
    if (item.state !== "published") continue;
    if (db.livePosts.some((live) => live.post.itemId === item.id)) continue;
    // The calendar's own posts of this item are dry runs: there is nothing to measure.
    if (db.posts.some((post) => post.itemId === item.id)) continue;
    goLive(item, item.targetAt ?? item.updatedAt, 9_000 + next() * 4_000);
  }

  const fresh = db.series.find((series) => series.name === "Ownership basics");
  if (fresh) {
    const publishedAt = new Date(now - 25 * 60_000).toISOString();
    const item = publishedItem(fresh, "Borrowing rules on one card", publishedAt);
    for (const target of channelsFor(item)) addLivePost(item, target, publishedAt, []);
  }
}
