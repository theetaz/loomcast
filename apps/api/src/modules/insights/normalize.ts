import type { JsonObject, Platform, PostFormat, PostMetricCounts } from "@loomcast/contracts";

// The insights call of each platform and post format, and how its answer becomes one
// `post_metrics` row. Metric names follow Meta's references (Graph API v26.0, Threads API v1.0):
// - Instagram Reels: `GET /{ig-media-id}/insights?metric=views,reach,likes,comments,shares,saved,
//   total_interactions,ig_reels_avg_watch_time` (`plays` is gone; average watch time in ms);
// - Instagram photos and carousels (FEED): the same without `ig_reels_avg_watch_time`, which only
//   Reels report; a carousel is asked as a whole (its items have no insights);
// - Instagram stories (STORY): `views,reach,replies,shares,total_interactions`; stories report no
//   likes or saves, and their insights are kept for 24 hours only (`STORY_INSIGHTS_WINDOW_MS`),
//   so later pulls are skipped (IG Media insights reference, confirmed 2026-10-18:
//   https://developers.facebook.com/docs/instagram-platform/reference/instagram-media/insights);
// - Facebook Page Reels: `GET /{video-id}/video_insights?metric=...&period=lifetime` with
//   `fb_reels_total_plays` (plays including replays, falling back to `blue_reels_play_count`),
//   `post_impressions_unique` (reach), `post_video_avg_time_watched` (ms per play),
//   `post_video_likes_by_reaction_type` and `post_video_social_actions` (comments, shares);
// - Facebook videos (not Reels): the same edge with the `total_video_*` metrics: views, unique
//   impressions (reach), average watch time (ms), reactions by type and stories by action type
//   (comments, shares) (Video Insights reference, confirmed 2026-10-18:
//   https://developers.facebook.com/docs/graph-api/reference/video/video_insights/);
// - Facebook photos, multi-photo and text posts: `GET /{page-post-id}/insights?metric=
//   post_media_view,post_total_media_view_unique,post_reactions_by_type_total&period=lifetime`
//   (views, unique viewers as reach, reactions). `post_impressions_unique` and the other
//   impression metrics are discontinued after v25, and comments and shares are fields of the post
//   rather than insights, so they stay null (Page insights reference, confirmed 2026-10-18:
//   https://developers.facebook.com/docs/graph-api/reference/insights). The post's `externalId`
//   must be the Page post id (`{page-id}_{post-id}`);
// - Facebook stories: skipped, as no insights call for Page stories could be confirmed;
// - Threads: `GET /{threads-media-id}/insights?metric=views,likes,replies,reposts,quotes,shares`.
// Every answer is `{data: [{name, period, values: [{value}]}]}`; a metric with a breakdown answers
// `total_value: {value}` instead, which is read the same way.

/** Platforms whose posts get insights. X post metrics are not pulled yet. */
export const INSIGHTS_PLATFORMS = ["instagram", "facebook", "threads"] as const;
export type InsightsPlatform = (typeof INSIGHTS_PLATFORMS)[number];

export function supportsInsights(platform: Platform): platform is InsightsPlatform {
  return (INSIGHTS_PLATFORMS as readonly string[]).includes(platform);
}

export const INSTAGRAM_INSIGHTS_METRICS = [
  "views",
  "reach",
  "likes",
  "comments",
  "shares",
  "saved",
  "total_interactions",
  "ig_reels_avg_watch_time",
] as const;

/** Instagram photos and carousels (FEED media). */
export const INSTAGRAM_FEED_INSIGHTS_METRICS = [
  "views",
  "reach",
  "likes",
  "comments",
  "shares",
  "saved",
  "total_interactions",
] as const;

/** Instagram stories (STORY media). */
export const INSTAGRAM_STORY_INSIGHTS_METRICS = [
  "views",
  "reach",
  "replies",
  "shares",
  "total_interactions",
] as const;

export const FACEBOOK_REELS_INSIGHTS_METRICS = [
  "blue_reels_play_count",
  "fb_reels_total_plays",
  "post_impressions_unique",
  "post_video_avg_time_watched",
  "post_video_likes_by_reaction_type",
  "post_video_social_actions",
] as const;

/** Facebook videos that are not Reels. */
export const FACEBOOK_VIDEO_INSIGHTS_METRICS = [
  "total_video_views",
  "total_video_impressions_unique",
  "total_video_avg_time_watched",
  "total_video_reactions_by_type_total",
  "total_video_stories_by_action_type",
] as const;

/** Facebook photo, multi-photo and text posts (Page post insights). */
export const FACEBOOK_POST_INSIGHTS_METRICS = [
  "post_media_view",
  "post_total_media_view_unique",
  "post_reactions_by_type_total",
] as const;

export const THREADS_INSIGHTS_METRICS = [
  "views",
  "likes",
  "replies",
  "reposts",
  "quotes",
  "shares",
] as const;

/** How long a story's insights are kept after it goes live. */
export const STORY_INSIGHTS_WINDOW_MS = 24 * 60 * 60_000;

/** One insights call: the API it goes to, the path after the version, and its query. */
export interface InsightsCall {
  api: "graph" | "threads";
  path: string;
  query: Record<string, string>;
}

/**
 * The insights call for the platform's media id of a published post of `format` (a Reel when
 * not given). Null when the platform reports nothing for the format, such as a Facebook story.
 */
export function insightsRequest(
  platform: InsightsPlatform,
  mediaId: string,
  format: PostFormat = "reel",
): InsightsCall | null {
  const id = encodeURIComponent(mediaId);
  const metric = (names: readonly string[]) => names.join(",");
  switch (platform) {
    case "instagram":
      switch (format) {
        case "reel":
          return {
            api: "graph",
            path: `/${id}/insights`,
            query: { metric: metric(INSTAGRAM_INSIGHTS_METRICS) },
          };
        case "image":
        case "carousel":
          return {
            api: "graph",
            path: `/${id}/insights`,
            query: { metric: metric(INSTAGRAM_FEED_INSIGHTS_METRICS) },
          };
        case "story":
          return {
            api: "graph",
            path: `/${id}/insights`,
            query: { metric: metric(INSTAGRAM_STORY_INSIGHTS_METRICS) },
          };
        default:
          return null;
      }
    case "facebook":
      switch (format) {
        case "reel":
          return {
            api: "graph",
            path: `/${id}/video_insights`,
            query: { metric: metric(FACEBOOK_REELS_INSIGHTS_METRICS), period: "lifetime" },
          };
        case "video":
          return {
            api: "graph",
            path: `/${id}/video_insights`,
            query: { metric: metric(FACEBOOK_VIDEO_INSIGHTS_METRICS), period: "lifetime" },
          };
        case "image":
        case "carousel":
        case "text":
          return {
            api: "graph",
            path: `/${id}/insights`,
            query: { metric: metric(FACEBOOK_POST_INSIGHTS_METRICS), period: "lifetime" },
          };
        default:
          return null;
      }
    case "threads":
      return format === "reel"
        ? {
            api: "threads",
            path: `/${id}/insights`,
            query: { metric: metric(THREADS_INSIGHTS_METRICS) },
          }
        : null;
  }
}

/**
 * Whether a post's insights can no longer be read at `at`: a story's are gone 24 hours after it
 * went live.
 */
export function insightsExpired(format: PostFormat, publishedAt: Date | null, at: Date): boolean {
  return (
    format === "story" &&
    publishedAt !== null &&
    at.getTime() - publishedAt.getTime() >= STORY_INSIGHTS_WINDOW_MS
  );
}

/** A capture ready for `post_metrics`: the counts and the answer without credentials. */
export interface NormalizedInsights extends PostMetricCounts {
  raw: JsonObject;
}

/** Largest `avg_watch_ms` the integer column holds. */
const MAX_INT = 2_147_483_647;

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** A non-negative whole count, or null for anything else. */
export function countOf(value: unknown): number | null {
  let number: number | null = null;
  if (typeof value === "number" && Number.isFinite(value)) {
    number = value;
  } else if (typeof value === "string" && /^\d+(\.\d+)?$/.test(value.trim())) {
    number = Number(value.trim());
  }
  return number === null || number < 0 ? null : Math.round(number);
}

/** The sum of the counts in an object (such as reactions by type); a plain count passes through. */
function sumOf(value: unknown): number | null {
  const direct = countOf(value);
  if (direct !== null) {
    return direct;
  }
  const object = asObject(value);
  if (object === null) {
    return null;
  }
  let total: number | null = null;
  for (const entry of Object.values(object)) {
    const count = countOf(entry);
    if (count !== null) {
      total = (total ?? 0) + count;
    }
  }
  return total;
}

/** The entry of `object` whose key matches `name` case-insensitively, as a count. */
function keyCount(value: unknown, name: string): number | null {
  const object = asObject(value);
  if (object === null) {
    return null;
  }
  for (const [key, entry] of Object.entries(object)) {
    if (key.toLowerCase() === name) {
      return countOf(entry);
    }
  }
  return null;
}

/** Adds counts, ignoring the unreported ones; null when none is reported. */
function total(...counts: (number | null)[]): number | null {
  const reported = counts.filter((count): count is number => count !== null);
  return reported.length === 0 ? null : reported.reduce((sum, count) => sum + count, 0);
}

/** The value of each metric in an insights answer, by name. */
export function metricValues(body: unknown): Map<string, unknown> {
  const values = new Map<string, unknown>();
  const data = asObject(body)?.data;
  if (!Array.isArray(data)) {
    return values;
  }
  for (const entry of data) {
    const metric = asObject(entry);
    if (metric === null || typeof metric.name !== "string") {
      continue;
    }
    const first = Array.isArray(metric.values) ? asObject(metric.values[0]) : null;
    const value = first?.value ?? asObject(metric.total_value)?.value;
    if (value !== undefined) {
      values.set(metric.name, value);
    }
  }
  return values;
}

const CREDENTIAL_KEYS = new Set(["access_token", "appsecret_proof", "client_secret"]);
const CREDENTIAL_PARAM_RE = /\b(access_token|appsecret_proof|client_secret)=[^&\s"']*/gi;

/**
 * The answer as stored in `post_metrics.raw`: paging links dropped, and any credential key or
 * URL parameter removed wherever it appears.
 */
export function stripCredentials(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(CREDENTIAL_PARAM_RE, "$1=[redacted]");
  }
  if (Array.isArray(value)) {
    return value.map(stripCredentials);
  }
  const object = asObject(value);
  if (object === null) {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(object)) {
    if (key === "paging" || CREDENTIAL_KEYS.has(key.toLowerCase())) {
      continue;
    }
    out[key] = stripCredentials(entry);
  }
  return out;
}

function watchMs(value: unknown): number | null {
  const count = countOf(value);
  return count === null ? null : Math.min(count, MAX_INT);
}

/**
 * Normalizes an insights answer of `platform` into the contract's counts. A metric the platform
 * did not report stays null. The metrics of every format of a platform are read, since each
 * call asks for one format's (`insightsRequest`): an Instagram story's `replies` count as its
 * comments; a Facebook video, photo or text post reads its own views, reach and reactions.
 * Threads `shares` adds reposts, quotes and shares; Threads reports no saves, reach or watch time.
 */
export function normalizeInsights(platform: InsightsPlatform, body: unknown): NormalizedInsights {
  const values = metricValues(body);
  const get = (name: string) => countOf(values.get(name));
  const raw = (asObject(stripCredentials(body)) ?? {}) as JsonObject;
  switch (platform) {
    case "instagram":
      return {
        views: get("views"),
        likes: get("likes"),
        comments: get("comments") ?? get("replies"),
        shares: get("shares"),
        saves: get("saved"),
        reach: get("reach"),
        avgWatchMs: watchMs(values.get("ig_reels_avg_watch_time")),
        raw,
      };
    case "facebook": {
      const social =
        values.get("post_video_social_actions") ?? values.get("total_video_stories_by_action_type");
      return {
        views:
          get("fb_reels_total_plays") ??
          get("blue_reels_play_count") ??
          get("total_video_views") ??
          get("post_media_view"),
        likes:
          sumOf(values.get("post_video_likes_by_reaction_type")) ??
          sumOf(values.get("total_video_reactions_by_type_total")) ??
          sumOf(values.get("post_reactions_by_type_total")),
        comments: keyCount(social, "comment"),
        shares: keyCount(social, "share"),
        saves: null,
        reach:
          get("post_impressions_unique") ??
          get("total_video_impressions_unique") ??
          get("post_total_media_view_unique"),
        avgWatchMs: watchMs(
          values.get("post_video_avg_time_watched") ?? values.get("total_video_avg_time_watched"),
        ),
        raw,
      };
    }
    case "threads":
      return {
        views: get("views"),
        likes: get("likes"),
        comments: get("replies"),
        shares: total(get("reposts"), get("quotes"), get("shares")),
        saves: null,
        reach: null,
        avgWatchMs: null,
        raw,
      };
  }
}
