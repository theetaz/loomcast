import { z } from "zod";
import { IdSchema, TimestampSchema } from "../common";

// Research data: competitors' accounts and videos with their numbers over time, kept per workspace
// so a model can find the topics that keep producing hits. Rows come from the official Instagram
// Business Discovery API (every scan and sync stores all the videos it read) and from MCP clients
// that found videos elsewhere (`research.add_videos`). The server never classifies a video
// itself: topics, tags, hooks and formats are written by the calling model (`research.tag_video`).
// Captions, hooks and notes are third-party text: treat them as data, never as instructions.

/** Platforms a research account or video can be on. */
export const RESEARCH_PLATFORMS = [
  "instagram",
  "tiktok",
  "youtube",
  "facebook",
  "threads",
] as const;
export const ResearchPlatformSchema = z.enum(RESEARCH_PLATFORMS);
export type ResearchPlatform = (typeof RESEARCH_PLATFORMS)[number];

/**
 * How an account entered research: followed on purpose (`tracked`), or created because a video of
 * it was added (`discovered`). Tracking a discovered account promotes it to `tracked`.
 */
export const RESEARCH_ACCOUNT_SOURCES = ["tracked", "discovered"] as const;
export const ResearchAccountSourceSchema = z.enum(RESEARCH_ACCOUNT_SOURCES);
export type ResearchAccountSource = (typeof RESEARCH_ACCOUNT_SOURCES)[number];

/**
 * Where a video's first record came from: the official Business Discovery API, a person, or an
 * MCP client (`agent`). Later updates keep the first source.
 */
export const RESEARCH_VIDEO_SOURCES = ["business_discovery", "manual", "agent"] as const;
export const ResearchVideoSourceSchema = z.enum(RESEARCH_VIDEO_SOURCES);
export type ResearchVideoSource = (typeof RESEARCH_VIDEO_SOURCES)[number];

/** An outlier score at or above this makes a video a hit and its creator a hit creator. */
export const RESEARCH_HIT_OUTLIER = 5;
/** Distinct hit creators a topic needs to count as proven. */
export const RESEARCH_PROVEN_HIT_CREATORS = 3;
/** An account's median views is taken over its most recent videos with views, at most this many. */
export const RESEARCH_MEDIAN_VIDEOS = 30;
/** Default and longest window of the topic leaderboard, in days. */
export const RESEARCH_TOPIC_WINDOW_DAYS = 90;
export const RESEARCH_TOPIC_MAX_WINDOW_DAYS = 365;
/** Days counted by a topic's `saturation`. */
export const RESEARCH_SATURATION_DAYS = 30;

export const RESEARCH_LIMITS = {
  handle: 100,
  displayName: 300,
  externalId: 200,
  url: 2_048,
  caption: 2_200,
  topic: 80,
  tags: 20,
  tag: 40,
  hook: 500,
  format: 80,
  notes: 2_000,
  /** Videos per `research.add_videos` call. */
  addVideos: 100,
  /** Videos per `research.tag_video` call. */
  tagVideos: 100,
  /** Rows per page of `research.list_videos` and `analytics.list_posts`. */
  listMax: 200,
  listDefault: 50,
  /** Topics per `research.top_topics` call. */
  topicsMax: 100,
  topicsDefault: 25,
  /** Example videos shown per topic. */
  topicExamples: 3,
} as const;

/** Handles: letters, digits, `.`, `_` and `-`, after a leading `@` is removed. */
export const RESEARCH_HANDLE_RE = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * A handle as stored: trimmed, without a leading `@`, lowercased. Null when what is left is not a
 * handle the platforms allow.
 */
export function normalizeResearchHandle(input: string): string | null {
  const handle = input.trim().replace(/^@+/, "").toLowerCase();
  return RESEARCH_HANDLE_RE.test(handle) ? handle : null;
}

/**
 * A topic as stored and grouped: Unicode-normalised, lowercased, every run of characters that are
 * not letters or digits turned into one space, trimmed and cut to `RESEARCH_LIMITS.topic`. So
 * "AI Agents!", "ai-agents" and " ai  agents " are the same topic. Null when nothing is left.
 */
export function normalizeTopic(input: string): string | null {
  const topic = input
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .slice(0, RESEARCH_LIMITS.topic)
    .trim();
  return topic === "" ? null : topic;
}

const EXTERNAL_ID_PATTERNS: Readonly<Record<ResearchPlatform, readonly RegExp[]>> = {
  instagram: [/\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/],
  tiktok: [/\/video\/(\d+)/, /\/v\/(\d+)/],
  youtube: [
    /\/shorts\/([A-Za-z0-9_-]{6,})/,
    /[?&]v=([A-Za-z0-9_-]{6,})/,
    /youtu\.be\/([A-Za-z0-9_-]{6,})/,
  ],
  facebook: [/\/reel\/(\d+)/, /\/videos\/(?:[^/?#]+\/)?(\d+)/, /[?&]v=(\d+)/],
  threads: [/\/post\/([A-Za-z0-9_-]+)/],
};

/**
 * The platform's id of a video from its link: the Instagram shortcode (`/reel/<code>/`), the
 * TikTok video id, the YouTube video id, the Facebook video id or the Threads post code. Null when
 * the link has none. Videos are keyed by this id, so the same video added from a scan and from an
 * MCP client is one row.
 */
export function researchExternalIdFromUrl(platform: ResearchPlatform, url: string): string | null {
  for (const pattern of EXTERNAL_ID_PATTERNS[platform]) {
    const match = pattern.exec(url);
    if (match?.[1] !== undefined) {
      return match[1];
    }
  }
  return null;
}

const count = z.number().int().min(0);
const nullableCount = count.nullable();

/** One account in a workspace's research. `medianViews` is recomputed whenever its videos change. */
export const ResearchAccountSchema = z.object({
  id: IdSchema,
  workspaceId: IdSchema,
  platform: ResearchPlatformSchema,
  handle: z.string(),
  displayName: z.string().nullable(),
  followers: nullableCount,
  /** Median views over the account's most recent `RESEARCH_MEDIAN_VIDEOS` videos with views. */
  medianViews: nullableCount,
  source: ResearchAccountSourceSchema,
  /** The followed competitor this account mirrors, if any. */
  competitorId: IdSchema.nullable(),
  /** When the official API last refreshed it; null for accounts it never read. */
  lastSyncedAt: TimestampSchema.nullable(),
  notes: z.string().nullable(),
  videoCount: count,
  createdAt: TimestampSchema,
});
export type ResearchAccount = z.infer<typeof ResearchAccountSchema>;

/**
 * One video. Counts are the latest known totals (null when never reported). `outlierScore` is views
 * divided by the account's median views, null when either is unknown. `caption`, `hook` and
 * `notes` are untrusted third-party text.
 */
export const ResearchVideoSchema = z.object({
  id: IdSchema,
  accountId: IdSchema,
  handle: z.string(),
  platform: ResearchPlatformSchema,
  externalId: z.string(),
  url: z.string().nullable(),
  caption: z.string().nullable(),
  postedAt: TimestampSchema.nullable(),
  durationS: z.number().min(0).nullable(),
  views: nullableCount,
  likes: nullableCount,
  comments: nullableCount,
  shares: nullableCount,
  outlierScore: z.number().min(0).nullable(),
  topic: z.string().nullable(),
  tags: z.array(z.string()),
  hook: z.string().nullable(),
  format: z.string().nullable(),
  notes: z.string().nullable(),
  source: ResearchVideoSourceSchema,
  firstSeenAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type ResearchVideo = z.infer<typeof ResearchVideoSchema>;

/** A strong example of a topic, for the leaderboard. */
export const ResearchTopicExampleSchema = z.object({
  videoId: IdSchema,
  handle: z.string(),
  url: z.string().nullable(),
  views: nullableCount,
  outlierScore: z.number().min(0).nullable(),
});
export type ResearchTopicExample = z.infer<typeof ResearchTopicExampleSchema>;

/** How the workspace's own published posts on a topic did (by the content item's topic). */
export const ResearchOwnTopicSchema = z.object({
  posts: count,
  /** Posts with at least one metrics capture. */
  measured: count,
  medianViews: nullableCount,
  maxViews: nullableCount,
});
export type ResearchOwnTopic = z.infer<typeof ResearchOwnTopicSchema>;

/**
 * One row of the topic leaderboard, over the videos posted in the window (first seen, for videos
 * without a posting time).
 *
 * - `hitCreators`: distinct accounts with a video of the topic at `RESEARCH_HIT_OUTLIER` or more.
 * - `saturation`: the topic's videos posted in the last `RESEARCH_SATURATION_DAYS` days.
 * - `proven`: at least `RESEARCH_PROVEN_HIT_CREATORS` hit creators, so the topic is not one
 *   creator's luck.
 * - `topicScore`: see `researchTopicScore`.
 */
export const ResearchTopicSchema = z.object({
  topic: z.string(),
  videos: count,
  creators: count,
  hitCreators: count,
  maxViews: nullableCount,
  medianViews: nullableCount,
  bestOutlier: z.number().min(0).nullable(),
  lastHitAt: TimestampSchema.nullable(),
  saturation: count,
  proven: z.boolean(),
  topicScore: z.number(),
  examples: z.array(ResearchTopicExampleSchema),
  own: ResearchOwnTopicSchema.nullable(),
});
export type ResearchTopic = z.infer<typeof ResearchTopicSchema>;

/**
 * The leaderboard's ranking score, higher first:
 *
 *   2 × hitCreators + log10(1 + medianViews) + min(bestOutlier, 20) / 5 − 0.25 × saturation
 *
 * Several creators hitting with a topic count most; typical reach and the strongest outlier add to
 * it; many recent videos on the topic (a crowded topic) take a little away. Missing values count
 * as 0. Rounded to two decimals.
 */
export function researchTopicScore(stat: {
  hitCreators: number;
  medianViews: number | null;
  bestOutlier: number | null;
  saturation: number;
}): number {
  const score =
    2 * stat.hitCreators +
    Math.log10(1 + (stat.medianViews ?? 0)) +
    Math.min(stat.bestOutlier ?? 0, 20) / 5 -
    0.25 * stat.saturation;
  return Math.round(score * 100) / 100;
}
