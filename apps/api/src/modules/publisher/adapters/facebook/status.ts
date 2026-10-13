import { PermalinkSchema } from "@loomcast/contracts";
import { z } from "zod";
import { sanitizeMetaMessage } from "../../../../lib/meta-graph";
import { publishError } from "../../errors";
import type { StatusResult } from "../../types";

// `GET /{video-id}?fields=status,permalink_url` reports a Reel in three phases: uploading,
// processing and publishing, each `not_started`, `in_progress`, `complete` (the reference also
// says `completed`) or `error`, plus an overall `video_status` (`uploading`, `upload_complete`,
// `processing`, `ready`, `upload_failed`, `expired`, `error`) and the publishing phase's
// `publish_status` (`published`, `scheduled`, `draft`, `error`).

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

/** The https permalink of a Reel: `permalink_url` (often relative), else `/reel/<id>`. */
export function facebookPermalink(videoId: string, permalinkUrl: string | undefined): string {
  let candidate = permalinkUrl?.trim() ?? "";
  if (candidate.startsWith("/")) {
    candidate = `${FACEBOOK_ORIGIN}${candidate}`;
  }
  return PermalinkSchema.safeParse(candidate).success && candidate.startsWith("https://")
    ? candidate
    : `${FACEBOOK_ORIGIN}/reel/${encodeURIComponent(videoId)}`;
}

/** Whether the publishing phase has started, so a `finish` call took effect. */
export function finishTookEffect(video: FacebookVideo): boolean {
  const publishing = video.status?.publishing_phase;
  return (
    (publishing?.status !== undefined && publishing.status !== "not_started") ||
    publishing?.publish_status === "published"
  );
}

/** What a video's status means for the post. */
export function facebookStatusOf(videoId: string, video: FacebookVideo): StatusResult {
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
        phaseMessage(publishing) ?? "The platform could not publish the Reel.",
        { retryable: false, platformCode: "publishing_error" },
      ),
    };
  }
  if (videoStatus === "expired") {
    return {
      state: "failed",
      error: publishError("permanent", "The upload expired before the Reel was published.", {
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
    return {
      state: "published",
      externalId: video.id ?? videoId,
      permalink: facebookPermalink(video.id ?? videoId, video.permalink_url),
    };
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
        `The platform kept the Reel as ${publishing.publish_status === "draft" ? "a draft" : "scheduled"} instead of publishing it.`,
        { retryable: false, platformCode: publishing.publish_status },
      ),
    };
  }
  return { state: "pending" };
}
