import { z } from "zod";

// Telling whether a publishing call lost in transit took effect. The Graph API has no idempotency
// key, so after a timeout or a 5xx on the call that publishes a feed post, photo post or photo
// story, the adapter reads the Page's latest posts or stories and looks for the one it sent:
// - `GET /{page-id}/feed?fields=id,message,created_time,permalink_url,attachments{...}`: a post
//   created since the attempt started with the same message, or (multi-photo) attaching one of
//   the photos the attempt uploaded;
// - `GET /{page-id}/stories?fields=post_id,url,status,creation_time,media_type`: a photo story
//   created since the attempt started.
// A post that matches is taken as published instead of being sent again. Page Videos cannot be
// read back this way (`GET /{page-id}/videos` is not available), so a lost video upload fails
// without a retry instead. Confirmed against the Graph API v26.0 Page Feed reference and the
// Page Stories guide on 2026-10-18.

/** How far before the attempt's start a match may be, for the platform's clock. */
export const RECOVERY_CLOCK_SKEW_MS = 2 * 60_000;

const GraphId = z.union([z.string().min(1), z.number()]).transform(String);

export const FacebookFeedSchema = z.object({
  data: z.array(
    z.object({
      id: GraphId,
      message: z.string().optional(),
      created_time: z.string().optional(),
      permalink_url: z.string().optional(),
      attachments: z.unknown().optional(),
    }),
  ),
});
export type FacebookFeed = z.infer<typeof FacebookFeedSchema>;
export type FacebookFeedPost = FacebookFeed["data"][number];

export const FacebookStoriesSchema = z.object({
  data: z.array(
    z.object({
      post_id: GraphId.optional(),
      url: z.string().optional(),
      status: z.string().optional(),
      creation_time: z.union([z.string(), z.number()]).optional(),
      media_type: z.string().optional(),
    }),
  ),
});
export type FacebookStories = z.infer<typeof FacebookStoriesSchema>;
export type FacebookStory = FacebookStories["data"][number];

/** A Graph time (`2026-10-18T10:00:00+0000`) or UNIX seconds as epoch ms; null when unreadable. */
export function graphTimeMs(value: string | number | undefined): number | null {
  if (value === undefined) {
    return null;
  }
  if (typeof value === "number" || /^\d+$/.test(value)) {
    const seconds = Number(value);
    return Number.isFinite(seconds) ? seconds * 1_000 : null;
  }
  const ms = Date.parse(value.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
  return Number.isNaN(ms) ? null : ms;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function dataOf(value: unknown): unknown[] {
  const data = asRecord(value)?.data;
  return Array.isArray(data) ? data : [];
}

/** The ids of the photos a feed post attaches (`attachments{subattachments{target{id}}}`). */
export function attachedPhotoIds(post: FacebookFeedPost): string[] {
  const ids: string[] = [];
  for (const attachment of dataOf(post.attachments)) {
    for (const sub of dataOf(asRecord(attachment)?.subattachments)) {
      const id = asRecord(asRecord(sub)?.target)?.id;
      if (typeof id === "string" || typeof id === "number") {
        ids.push(String(id));
      }
    }
  }
  return ids;
}

/**
 * The post of `feed` the lost call created: created at `since` or later and carrying `message`
 * (when not empty) or one of `photoIds`. Null when none does.
 */
export function findSentPost(
  feed: FacebookFeed,
  sent: { message: string; photoIds?: readonly string[] },
  since: Date,
): FacebookFeedPost | null {
  const earliest = since.getTime() - RECOVERY_CLOCK_SKEW_MS;
  const photos = new Set(sent.photoIds ?? []);
  return (
    feed.data.find((post) => {
      const created = graphTimeMs(post.created_time);
      if (created === null || created < earliest) {
        return false;
      }
      if (photos.size > 0 && attachedPhotoIds(post).some((id) => photos.has(id))) {
        return true;
      }
      return sent.message !== "" && post.message?.trim() === sent.message;
    }) ?? null
  );
}

/** The photo story of `stories` created at `since` or later; null when there is none. */
export function findSentPhotoStory(stories: FacebookStories, since: Date): FacebookStory | null {
  const earliest = since.getTime() - RECOVERY_CLOCK_SKEW_MS;
  return (
    stories.data.find((story) => {
      const created = graphTimeMs(story.creation_time);
      return (
        story.post_id !== undefined &&
        story.media_type?.toLowerCase() === "photo" &&
        created !== null &&
        created >= earliest
      );
    }) ?? null
  );
}

/** The story with `postId` in `stories`; null when it is not listed. */
export function storyByPostId(stories: FacebookStories, postId: string): FacebookStory | null {
  return stories.data.find((story) => story.post_id === postId) ?? null;
}
