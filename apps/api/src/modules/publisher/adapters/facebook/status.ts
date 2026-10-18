import { PermalinkSchema } from "@loomcast/contracts";
import { z } from "zod";
import { sanitizeMetaMessage } from "../../../../lib/meta-graph";
import { publishError } from "../../errors";
import type { StatusResult } from "../../types";

// `GET /{video-id}?fields=status,permalink_url` reports a Reel in three phases: uploading,
// processing and publishing, each `not_started`, `in_progress`, `complete` (the reference also
// says `completed`) or `error`, plus an overall `video_status` (`uploading`, `upload_complete`,
// `processing`, `ready`, `upload_failed`, `expired`, `error`) and the publishing phase's
// `publish_status` (`published`, `scheduled`, `draft`, `error`). Page videos and video stories
// report the same phases (the Page Stories guide gives `publish_status` as `published` or
// `not_published`; confirmed 2026-10-18), so one reading serves all three.

/** Where Facebook's relative permalinks (`/reel/<id>/`) point. */
export const FACEBOOK_ORIGIN = "https://www.facebook.com";

const PhaseSchema = z.object({
  status: z.string().optional(),
  error: z.unknown().optional(),
  errors: z.unknown().optional(),
});

const PublishingPhaseSchema = PhaseSchema.extend({
  publish_status: z.string().optional(),
});

export const FacebookVideoSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String).optional(),
  permalink_url: z.string().optional(),
  status: z
    .object({
      video_status: z.string().optional(),
      uploading_phase: PhaseSchema.optional(),
      processing_phase: PhaseSchema.optional(),
      publishing_phase: PublishingPhaseSchema.optional(),
    })
    .optional(),
});
export type FacebookVideo = z.infer<typeof FacebookVideoSchema>;

const COMPLETE = new Set(["complete", "completed"]);
const FAILED_VIDEO_STATUSES = new Set(["error", "upload_failed"]);

/** The first message of a phase's `error` object or `errors` list. */
function phaseMessage(phase: z.infer<typeof PhaseSchema> | undefined): string | null {
  for (const candidate of [phase?.error, ...(Array.isArray(phase?.errors) ? phase.errors : [])]) {
    if (candidate !== null && typeof candidate === "object" && "message" in candidate) {
      const message = (candidate as { message: unknown }).message;
      if (typeof message === "string" && message.trim() !== "") {
        return sanitizeMetaMessage(message);
      }
    }
  }
  return null;
}

/** `candidate` as an https permalink (relative ones on `FACEBOOK_ORIGIN`), else `fallback`. */
function permalinkOr(candidate: string | undefined, fallback: string): string {
  let link = candidate?.trim() ?? "";
  if (link.startsWith("/")) {
    link = `${FACEBOOK_ORIGIN}${link}`;
  }
  return PermalinkSchema.safeParse(link).success && link.startsWith("https://") ? link : fallback;
}

/** The https permalink of a Reel: `permalink_url` (often relative), else `/reel/<id>`. */
export function facebookPermalink(videoId: string, permalinkUrl: string | undefined): string {
  return permalinkOr(permalinkUrl, `${FACEBOOK_ORIGIN}/reel/${encodeURIComponent(videoId)}`);
}

/** The https permalink of a Page video: `permalink_url`, else `/watch/?v=<id>`. */
export function facebookVideoPermalink(videoId: string, permalinkUrl: string | undefined): string {
  return permalinkOr(permalinkUrl, `${FACEBOOK_ORIGIN}/watch/?v=${encodeURIComponent(videoId)}`);
}

/**
 * The https permalink of a feed post, photo post or story: `permalink_url` (a story's `url`),
 * else `/<post-id>`, which the Pages posts guide gives as a post's link.
 */
export function facebookPostPermalink(postId: string, permalinkUrl: string | undefined): string {
  return permalinkOr(permalinkUrl, `${FACEBOOK_ORIGIN}/${encodeURIComponent(postId)}`);
}

/** Which kind of video a status belongs to, for its messages and permalink. */
export type FacebookVideoKind = "reel" | "video" | "story";

const VIDEO_LABELS: { readonly [K in FacebookVideoKind]: string } = {
  reel: "Reel",
  video: "video",
  story: "story",
};

/** Whether the publishing phase has started, so a `finish` call took effect. */
export function finishTookEffect(video: FacebookVideo): boolean {
  const publishing = video.status?.publishing_phase;
  return (
    (publishing?.status !== undefined && publishing.status !== "not_started") ||
    publishing?.publish_status === "published"
  );
}

/**
 * What a video's status means for the post: a Reel, a Page video or a video story, which report
 * the same phases. A published story keeps the story post id its finish returned (no
 * `externalId`) and gets its permalink from the Page's stories, read by the caller.
 */
export function facebookStatusOf(
  videoId: string,
  video: FacebookVideo,
  kind: FacebookVideoKind = "reel",
): StatusResult {
  const label = VIDEO_LABELS[kind];
  const status = video.status;
  const uploading = status?.uploading_phase;
  const processing = status?.processing_phase;
  const publishing = status?.publishing_phase;
  const videoStatus = status?.video_status;

  if (uploading?.status === "error" || processing?.status === "error") {
    const phase = uploading?.status === "error" ? "upload" : "processing";
    return {
      state: "failed",
      error: publishError(
        "invalid_media",
        phaseMessage(uploading?.status === "error" ? uploading : processing) ??
          `The platform could not use the video (${phase} failed).`,
        { retryable: false, platformCode: `${phase}_error` },
      ),
    };
  }
  if (publishing?.status === "error" || publishing?.publish_status === "error") {
    return {
      state: "failed",
      error: publishError(
        "permanent",
        phaseMessage(publishing) ?? `The platform could not publish the ${label}.`,
        { retryable: false, platformCode: "publishing_error" },
      ),
    };
  }
  if (videoStatus === "expired") {
    return {
      state: "failed",
      error: publishError("permanent", `The upload expired before the ${label} was published.`, {
        retryable: false,
        platformCode: "expired",
      }),
    };
  }
  if (videoStatus !== undefined && FAILED_VIDEO_STATUSES.has(videoStatus)) {
    return {
      state: "failed",
      error: publishError(
        "invalid_media",
        phaseMessage(processing) ?? "The platform could not process the video.",
        { retryable: false, platformCode: videoStatus },
      ),
    };
  }
  const published =
    publishing?.publish_status === "published" ||
    (publishing?.status !== undefined &&
      COMPLETE.has(publishing.status) &&
      publishing.publish_status === undefined);
  if (published) {
    const id = video.id ?? videoId;
    switch (kind) {
      case "reel":
        return {
          state: "published",
          externalId: id,
          permalink: facebookPermalink(id, video.permalink_url),
        };
      case "video":
        return {
          state: "published",
          externalId: id,
          permalink: facebookVideoPermalink(id, video.permalink_url),
        };
      case "story":
        return { state: "published" };
    }
  }
  if (
    publishing?.status !== undefined &&
    COMPLETE.has(publishing.status) &&
    (publishing.publish_status === "draft" || publishing.publish_status === "scheduled")
  ) {
    return {
      state: "failed",
      error: publishError(
        "permanent",
        `The platform kept the ${label} as ${publishing.publish_status === "draft" ? "a draft" : "scheduled"} instead of publishing it.`,
        { retryable: false, platformCode: publishing.publish_status },
      ),
    };
  }
  return { state: "pending" };
}
