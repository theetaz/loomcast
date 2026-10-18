import {
  RESEARCH_HIT_OUTLIER,
  RESEARCH_LIMITS,
  RESEARCH_PROVEN_HIT_CREATORS,
  RESEARCH_SATURATION_DAYS,
  type ResearchOwnTopic,
  type ResearchTopic,
  researchTopicScore,
} from "@loomcast/contracts";

// The arithmetic of research: medians, outlier scores and the topic leaderboard. Pure, so the
// rules are tested without a database; the service feeds it rows.

const DAY_MS = 24 * 60 * 60_000;

/** The median of `values`, rounded to a whole number; null for an empty list. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const value =
    sorted.length % 2 === 1
      ? (sorted[middle] as number)
      : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
  return Math.round(value);
}

/**
 * A video's outlier score: its views divided by its account's median views, rounded to two
 * decimals. Null when either is unknown or the median is 0.
 */
export function outlierScore(views: number | null, medianViews: number | null): number | null {
  if (views === null || medianViews === null || medianViews <= 0) return null;
  return Math.round((views / medianViews) * 100) / 100;
}

/** What the leaderboard reads of one research video. */
export interface LeaderboardVideo {
  id: string;
  accountId: string;
  handle: string;
  url: string | null;
  /** Normalised topic, or null while untagged. */
  topic: string | null;
  views: number | null;
  outlierScore: number | null;
  /** When it was posted, or first seen when the posting time is unknown. */
  at: Date;
}

/** One of the workspace's own live posts, by its content item's normalised topic. */
export interface OwnTopicPost {
  topic: string;
  /** Latest captured views; null before the first capture. */
  views: number | null;
}

export interface LeaderboardOptions {
  now: Date;
  /** Videos before `now - windowDays` are left out. */
  windowDays: number;
  minHitCreators: number;
  limit: number;
}

export interface Leaderboard {
  topics: ResearchTopic[];
  /** Videos in the window without a topic. */
  untagged: number;
}

function isHit(video: LeaderboardVideo): boolean {
  return video.outlierScore !== null && video.outlierScore >= RESEARCH_HIT_OUTLIER;
}

function maxOf(values: readonly number[]): number | null {
  return values.length === 0 ? null : Math.max(...values);
}

function ownStats(posts: readonly OwnTopicPost[]): ResearchOwnTopic {
  const views = posts.flatMap((post) => (post.views === null ? [] : [post.views]));
  return {
    posts: posts.length,
    measured: views.length,
    medianViews: median(views),
    maxViews: maxOf(views),
  };
}

/** Strongest first: highest outlier score (unknown last), then most views. */
function byStrength(a: LeaderboardVideo, b: LeaderboardVideo): number {
  return (b.outlierScore ?? -1) - (a.outlierScore ?? -1) || (b.views ?? -1) - (a.views ?? -1);
}

function topicStats(
  topic: string,
  videos: readonly LeaderboardVideo[],
  own: readonly OwnTopicPost[] | undefined,
  now: Date,
): ResearchTopic {
  const views = videos.flatMap((video) => (video.views === null ? [] : [video.views]));
  const outliers = videos.flatMap((video) =>
    video.outlierScore === null ? [] : [video.outlierScore],
  );
  const hits = videos.filter(isHit);
  const saturationFrom = now.getTime() - RESEARCH_SATURATION_DAYS * DAY_MS;
  const lastHit = maxOf(hits.map((video) => video.at.getTime()));
  const stat = {
    topic,
    videos: videos.length,
    creators: new Set(videos.map((video) => video.accountId)).size,
    hitCreators: new Set(hits.map((video) => video.accountId)).size,
    maxViews: maxOf(views),
    medianViews: median(views),
    bestOutlier: maxOf(outliers),
    lastHitAt: lastHit === null ? null : new Date(lastHit).toISOString(),
    saturation: videos.filter((video) => video.at.getTime() >= saturationFrom).length,
  };
  return {
    ...stat,
    proven: stat.hitCreators >= RESEARCH_PROVEN_HIT_CREATORS,
    topicScore: researchTopicScore(stat),
    examples: [...videos]
      .sort(byStrength)
      .slice(0, RESEARCH_LIMITS.topicExamples)
      .map((video) => ({
        videoId: video.id,
        handle: video.handle,
        url: video.url,
        views: video.views,
        outlierScore: video.outlierScore,
      })),
    own: own === undefined || own.length === 0 ? null : ownStats(own),
  };
}

/**
 * The topic leaderboard: the videos in the window grouped by topic, ranked by `topicScore`, then
 * by video count, then by name. Topics with fewer than `minHitCreators` hit creators are left out.
 * `own` joins the workspace's own posts by the same normalised topic.
 */
export function topicLeaderboard(
  videos: readonly LeaderboardVideo[],
  own: readonly OwnTopicPost[],
  options: LeaderboardOptions,
): Leaderboard {
  const from = options.now.getTime() - options.windowDays * DAY_MS;
  const groups = new Map<string, LeaderboardVideo[]>();
  let untagged = 0;
  for (const video of videos) {
    if (video.at.getTime() < from) continue;
    if (video.topic === null) {
      untagged += 1;
      continue;
    }
    const group = groups.get(video.topic) ?? [];
    group.push(video);
    groups.set(video.topic, group);
  }
  const ownByTopic = new Map<string, OwnTopicPost[]>();
  for (const post of own) {
    const group = ownByTopic.get(post.topic) ?? [];
    group.push(post);
    ownByTopic.set(post.topic, group);
  }
  const topics = [...groups.entries()]
    .map(([topic, group]) => topicStats(topic, group, ownByTopic.get(topic), options.now))
    .filter((topic) => topic.hitCreators >= options.minHitCreators)
    .sort(
      (a, b) =>
        b.topicScore - a.topicScore || b.videos - a.videos || a.topic.localeCompare(b.topic),
    )
    .slice(0, options.limit);
  return { topics, untagged };
}
