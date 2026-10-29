import {
  ANALYTICS_TOP_POSTS,
  type AnalyticsOverview,
  type AnalyticsOverviewQuery,
  type AnalyticsPost,
  aggregatePosts,
  type DailyViews,
  type ItemAnalytics,
  insightsSchedule,
  PLATFORMS,
  type PostAnalytics,
  type PostMetrics,
  type PostPerformance,
  type SeriesAnalytics,
  type SeriesAnalyticsQuery,
} from "@loomcast/contracts";
import {
  channels,
  contentItems,
  type Database,
  latestPostMetrics,
  postMetrics,
  scheduledPosts,
  series,
} from "@loomcast/db";
import { and, asc, desc, eq, gte, inArray, isNotNull, lt, type SQL, sql } from "drizzle-orm";
import { supportsInsights } from "../insights/normalize";
import { toPostMetrics } from "./mappers";

// Analytics of live posts: `published` and not dry-run. Every figure comes from each post's
// latest capture through the contracts' `aggregatePosts`, so the web app and the API agree.

/** A live post without its metrics. */
type LivePost = Omit<PostPerformance, "metrics">;

const liveColumns = {
  postId: scheduledPosts.id,
  itemId: scheduledPosts.itemId,
  workspaceId: contentItems.workspaceId,
  seriesId: sql<string | null>`coalesce(${scheduledPosts.seriesId}, ${contentItems.seriesId})`,
  channelId: scheduledPosts.channelId,
  platform: channels.platform,
  title: contentItems.title,
  permalink: scheduledPosts.permalink,
  publishedAt: scheduledPosts.publishedAt,
};

function inRange(range: { from?: string | undefined; to?: string | undefined }): SQL[] {
  return [
    ...(range.from === undefined ? [] : [gte(scheduledPosts.publishedAt, new Date(range.from))]),
    ...(range.to === undefined ? [] : [lt(scheduledPosts.publishedAt, new Date(range.to))]),
  ];
}

/** The latest capture of each post, by post id. */
async function latestOf(
  db: Database,
  posts: readonly LivePost[],
): Promise<Map<string, PostMetrics>> {
  const rows = await latestPostMetrics(
    db,
    posts.map((post) => post.postId),
  );
  return new Map(rows.map((row) => [row.postId, toPostMetrics(row)]));
}

function countsOf(metrics: PostMetrics | null) {
  if (metrics === null) return null;
  const { capturedAt: _capturedAt, ...counts } = metrics;
  return counts;
}

/**
 * When the next capture of `post` is due: the first time of its insights schedule after its latest
 * capture (after it went live, without one). Null once the schedule has run out, or for a
 * platform without insights.
 */
export function nextCaptureAt(post: LivePost, history: readonly PostMetrics[]): string | null {
  if (!supportsInsights(post.platform)) return null;
  const last = history.at(-1);
  const after = Date.parse(last?.capturedAt ?? post.publishedAt);
  const next = insightsSchedule(post.publishedAt).find((time) => time.getTime() > after);
  return next === undefined ? null : next.toISOString();
}

/** The overview of `posts` (oldest first) with their latest captures. */
export function overviewOf(
  posts: readonly PostPerformance[],
  range: { from: string; to: string },
): AnalyticsOverview {
  const totalsOf = (subset: readonly PostPerformance[]) =>
    aggregatePosts(subset.map((post) => countsOf(post.metrics)));

  const platforms = PLATFORMS.flatMap((platform) => {
    const own = posts.filter((post) => post.platform === platform);
    return own.length > 0 ? [{ platform, totals: totalsOf(own) }] : [];
  });

  const days = new Map<string, DailyViews>();
  for (const post of posts) {
    const date = new Date(post.publishedAt).toISOString().slice(0, 10);
    const key = `${date}|${post.platform}`;
    const row = days.get(key) ?? { date, platform: post.platform, posts: 0, views: 0 };
    row.posts += 1;
    row.views += post.metrics?.views ?? 0;
    days.set(key, row);
  }
  const daily = [...days.values()].sort(
    (a, b) =>
      a.date.localeCompare(b.date) || PLATFORMS.indexOf(a.platform) - PLATFORMS.indexOf(b.platform),
  );

  // Most views first; posts without a capture last; ties keep publish order.
  const topPosts = [...posts]
    .sort((a, b) => (b.metrics?.views ?? -1) - (a.metrics?.views ?? -1))
    .slice(0, ANALYTICS_TOP_POSTS);

  return { from: range.from, to: range.to, totals: totalsOf(posts), platforms, daily, topPosts };
}

export interface AnalyticsService {
  /** Null when the post is not live. */
  post(id: string): Promise<PostAnalytics | null>;
  /** Null when the item does not exist. */
  item(id: string): Promise<ItemAnalytics | null>;
  /** Null when the series does not exist. */
  series(id: string, query: SeriesAnalyticsQuery): Promise<SeriesAnalytics | null>;
  overview(query: AnalyticsOverviewQuery): Promise<AnalyticsOverview>;
  /**
   * Live posts newest first, each with its latest capture, its channel's name and its item's
   * topic: what `analytics.list_posts` shows on `/mcp`.
   */
  listPosts(query: {
    workspaceId?: string | undefined;
    since?: string | undefined;
    limit: number;
  }): Promise<AnalyticsPost[]>;
  /** The workspace of a post, or null when there is no such post. */
  postWorkspace(id: string): Promise<string | null>;
}

export function createAnalyticsService(db: Database): AnalyticsService {
  /** Live posts matching `where`, oldest `publishedAt` first. */
  async function livePosts(...where: SQL[]): Promise<LivePost[]> {
    const rows = await db
      .select(liveColumns)
      .from(scheduledPosts)
      .innerJoin(contentItems, eq(contentItems.id, scheduledPosts.itemId))
      .innerJoin(channels, eq(channels.id, scheduledPosts.channelId))
      .where(
        and(
          eq(scheduledPosts.status, "published"),
          eq(scheduledPosts.dryRun, false),
          isNotNull(scheduledPosts.publishedAt),
          ...where,
        ),
      )
      .orderBy(asc(scheduledPosts.publishedAt), asc(scheduledPosts.id));
    return rows.flatMap((row) =>
      row.publishedAt === null
        ? []
        : [
            {
              ...row,
              permalink: row.permalink?.startsWith("https://") ? row.permalink : null,
              publishedAt: row.publishedAt.toISOString(),
            },
          ],
    );
  }

  async function withLatest(posts: readonly LivePost[]): Promise<PostPerformance[]> {
    const latest = await latestOf(db, posts);
    return posts.map((post) => ({ ...post, metrics: latest.get(post.postId) ?? null }));
  }

  /** Every capture of each post, oldest first. */
  async function historiesOf(postIds: readonly string[]): Promise<Map<string, PostMetrics[]>> {
    const histories = new Map<string, PostMetrics[]>(postIds.map((id) => [id, []]));
    if (postIds.length === 0) return histories;
    const rows = await db
      .select()
      .from(postMetrics)
      .where(inArray(postMetrics.postId, [...postIds]))
      .orderBy(asc(postMetrics.capturedAt), asc(postMetrics.id));
    for (const row of rows) {
      histories.get(row.postId)?.push(toPostMetrics(row));
    }
    return histories;
  }

  function analyticsOf(post: LivePost, history: PostMetrics[]): PostAnalytics {
    return {
      post: { ...post, metrics: history.at(-1) ?? null },
      history,
      nextCaptureAt: nextCaptureAt(post, history),
    };
  }

  return {
    async post(id) {
      const [post] = await livePosts(eq(scheduledPosts.id, id));
      if (post === undefined) return null;
      const histories = await historiesOf([post.postId]);
      return analyticsOf(post, histories.get(post.postId) ?? []);
    },

    async item(id) {
      const [item] = await db
        .select({ id: contentItems.id })
        .from(contentItems)
        .where(eq(contentItems.id, id));
      if (item === undefined) return null;
      const posts = await livePosts(eq(scheduledPosts.itemId, id));
      const histories = await historiesOf(posts.map((post) => post.postId));
      const analytics = posts.map((post) => analyticsOf(post, histories.get(post.postId) ?? []));
      return {
        itemId: id,
        totals: aggregatePosts(analytics.map((entry) => countsOf(entry.post.metrics))),
        posts: analytics,
      };
    },

    async series(id, query) {
      const [found] = await db.select({ id: series.id }).from(series).where(eq(series.id, id));
      if (found === undefined) return null;
      const posts = await withLatest(
        await livePosts(
          sql`coalesce(${scheduledPosts.seriesId}, ${contentItems.seriesId}) = ${id}`,
          ...inRange(query),
        ),
      );
      return {
        seriesId: id,
        totals: aggregatePosts(posts.map((post) => countsOf(post.metrics))),
        posts,
      };
    },

    async listPosts(query) {
      const rows = await db
        .select({ ...liveColumns, channelName: channels.displayName, topic: contentItems.topic })
        .from(scheduledPosts)
        .innerJoin(contentItems, eq(contentItems.id, scheduledPosts.itemId))
        .innerJoin(channels, eq(channels.id, scheduledPosts.channelId))
        .where(
          and(
            eq(scheduledPosts.status, "published"),
            eq(scheduledPosts.dryRun, false),
            isNotNull(scheduledPosts.publishedAt),
            ...(query.workspaceId === undefined
              ? []
              : [eq(contentItems.workspaceId, query.workspaceId)]),
            ...inRange({ from: query.since }),
          ),
        )
        .orderBy(desc(scheduledPosts.publishedAt), desc(scheduledPosts.id))
        .limit(query.limit);
      const posts = rows.flatMap((row) =>
        row.publishedAt === null
          ? []
          : [
              {
                ...row,
                permalink: row.permalink?.startsWith("https://") ? row.permalink : null,
                publishedAt: row.publishedAt.toISOString(),
              },
            ],
      );
      const latest = await latestOf(db, posts);
      return posts.map((post) => ({ ...post, metrics: latest.get(post.postId) ?? null }));
    },

    async postWorkspace(id) {
      const [row] = await db
        .select({ workspaceId: contentItems.workspaceId })
        .from(scheduledPosts)
        .innerJoin(contentItems, eq(contentItems.id, scheduledPosts.itemId))
        .where(eq(scheduledPosts.id, id))
        .limit(1);
      return row?.workspaceId ?? null;
    },

    async overview(query) {
      const posts = await withLatest(
        await livePosts(
          ...inRange(query),
          ...(query.workspaceId === undefined
            ? []
            : [eq(contentItems.workspaceId, query.workspaceId)]),
        ),
      );
      return overviewOf(posts, query);
    },
  };
}
