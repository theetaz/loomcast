import type { PublishRequest } from "@loomcast/contracts";
import { limitCaption } from "../caption";
import {
  type BuildOptions,
  bearer,
  checkMedia,
  MB,
  type MediaFacts,
  PLACEHOLDERS,
  type PlanInput,
  type PlatformRequest,
  type PublishPlan,
  type RequestIssue,
  segment,
} from "./types";

// Facebook Page Reels: start an upload session, let the upload host fetch the public video URL,
// then finish with `video_state: PUBLISHED`. The video processes afterwards, so the post is
// pending until `status` reports it published.

/**
 * Page Reels limits from the platform's guide: 3 to 90 s, 9:16, at least 540×960. The guide gives
 * no file size limit; 1 GB keeps uploads reasonable.
 */
export const FACEBOOK_REELS_LIMITS = {
  minDurationMs: 3_000,
  maxDurationMs: 90_000,
  maxBytes: 1_024 * MB,
  minWidth: 540,
  minHeight: 960,
  minAspect: 0.5,
  maxAspect: 0.6,
  mimes: ["video/mp4", "video/quicktime"],
} as const;

export const facebookRequests = {
  /** `POST /{page-id}/video_reels {upload_phase: "start"}` returns `{video_id, upload_url}`. */
  startUpload(pageId: string, options: BuildOptions): PlatformRequest {
    return {
      step: "start_upload",
      method: "POST",
      api: "graph",
      path: `/${segment(pageId)}/video_reels`,
      headers: { Authorization: bearer(options.accessToken) },
      bodyEncoding: "json",
      body: { upload_phase: "start" },
    };
  },

  /**
   * `POST rupload.facebook.com/video-upload/<version>/{video-id}` with `file_url`: the upload host
   * fetches the public video itself. The token goes as `OAuth <token>`, as this host expects.
   */
  uploadFromUrl(videoId: string, videoUrl: string, options: BuildOptions): PlatformRequest {
    return {
      step: "upload",
      method: "POST",
      api: "rupload",
      path: `/${segment(videoId)}`,
      headers: { Authorization: `OAuth ${options.accessToken}`, file_url: videoUrl },
    };
  },

  /** `POST /{page-id}/video_reels {upload_phase: "finish", video_state: "PUBLISHED"}`. */
  finishUpload(request: PublishRequest, videoId: string, options: BuildOptions): PlatformRequest {
    return {
      step: "finish_upload",
      method: "POST",
      api: "graph",
      path: `/${segment(request.externalId)}/video_reels`,
      headers: { Authorization: bearer(options.accessToken) },
      bodyEncoding: "json",
      body: {
        upload_phase: "finish",
        video_id: videoId,
        video_state: "PUBLISHED",
        description: limitCaption("facebook", request.caption),
      },
    };
  },

  /** `GET /{video-id}?fields=status,permalink_url`: upload, processing and publishing phases. */
  videoStatus(videoId: string, options: BuildOptions): PlatformRequest {
    return {
      step: "video_status",
      method: "GET",
      api: "graph",
      path: `/${segment(videoId)}`,
      query: { fields: "status,permalink_url" },
      headers: { Authorization: bearer(options.accessToken) },
    };
  },
};

/** What `publish` sends: start, upload from the public URL, finish. Then it waits (pending). */
export function buildFacebookPublish(input: PlanInput): PublishPlan {
  return {
    platform: "facebook",
    pending: true,
    steps: [
      facebookRequests.startUpload(input.request.externalId, input),
      facebookRequests.uploadFromUrl(PLACEHOLDERS.videoId, input.request.videoUrl, input),
      facebookRequests.finishUpload(input.request, PLACEHOLDERS.videoId, input),
    ],
  };
}

export function validateFacebookRequest(
  request: PublishRequest,
  media: MediaFacts,
): RequestIssue[] {
  return checkMedia(request, media, FACEBOOK_REELS_LIMITS);
}
