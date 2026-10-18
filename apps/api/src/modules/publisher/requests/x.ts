import type { PublishRequest, VideoPublishRequest } from "@loomcast/contracts";
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
  videoOnlyIssues,
  videoPlanInput,
} from "./types";

// X: the v2 chunked media upload (initialize, append in 4 MB segments, finalize), polled until
// processing succeeds, then a post with the media id. Unlike the Meta platforms, X does not fetch
// a URL: the adapter streams the bytes from storage into each append. The token is the user's
// OAuth 2.0 bearer token.

/** Bytes per append segment. */
export const X_SEGMENT_BYTES = 4 * MB;

/** Video limits for posts: 0.5 to 140 s, 512 MB, MP4. */
export const X_VIDEO_LIMITS = {
  minDurationMs: 500,
  maxDurationMs: 140_000,
  maxBytes: 512 * MB,
  maxWidth: 1_920,
  minAspect: 1 / 3,
  maxAspect: 3,
  mimes: ["video/mp4"],
} as const;

function auth(options: BuildOptions): Record<string, string> {
  return { Authorization: bearer(options.accessToken) };
}

export const xRequests = {
  /** `POST /2/media/upload/initialize`. */
  initialize(media: MediaFacts, options: BuildOptions): PlatformRequest {
    return {
      step: "initialize",
      method: "POST",
      api: "x",
      path: "/2/media/upload/initialize",
      headers: auth(options),
      bodyEncoding: "json",
      body: { media_type: media.mime, total_bytes: media.bytes, media_category: "tweet_video" },
    };
  },

  /**
   * `POST /2/media/upload/{id}/append`, multipart: `segment_index` and the segment's bytes. The
   * plan shows the byte range instead of the bytes.
   */
  append(
    mediaId: string,
    index: number,
    range: { start: number; end: number },
    options: BuildOptions,
  ): PlatformRequest {
    return {
      step: "append",
      method: "POST",
      api: "x",
      path: `/2/media/upload/${segment(mediaId)}/append`,
      headers: auth(options),
      bodyEncoding: "form",
      body: { segment_index: index, media: `{bytes ${range.start}-${range.end - 1}}` },
    };
  },

  /** `POST /2/media/upload/{id}/finalize`. */
  finalize(mediaId: string, options: BuildOptions): PlatformRequest {
    return {
      step: "finalize",
      method: "POST",
      api: "x",
      path: `/2/media/upload/${segment(mediaId)}/finalize`,
      headers: auth(options),
    };
  },

  /** `GET /2/media/upload?command=STATUS&media_id=`: processing state of the upload. */
  status(mediaId: string, options: BuildOptions): PlatformRequest {
    return {
      step: "upload_status",
      method: "GET",
      api: "x",
      path: "/2/media/upload",
      query: { command: "STATUS", media_id: mediaId },
      headers: auth(options),
    };
  },

  /** `POST /2/tweets {text, media: {media_ids}}`. */
  createPost(
    request: VideoPublishRequest,
    mediaId: string,
    options: BuildOptions,
  ): PlatformRequest {
    return {
      step: "create_post",
      method: "POST",
      api: "x",
      path: "/2/tweets",
      headers: auth(options),
      bodyEncoding: "json",
      body: { text: limitCaption("x", request.caption), media: { media_ids: [mediaId] } },
    };
  },
};

/** The byte ranges of the append segments of a file of `bytes` bytes. */
export function xSegments(bytes: number): { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = [];
  for (let start = 0; start < bytes; start += X_SEGMENT_BYTES) {
    ranges.push({ start, end: Math.min(bytes, start + X_SEGMENT_BYTES) });
  }
  return ranges;
}

/** What `publish` sends: initialize, every append, finalize. Then it waits for processing. */
export function buildXPublish(plan: PlanInput): PublishPlan {
  const input = videoPlanInput(plan);
  const appends = xSegments(input.media.bytes).map((range, index) =>
    xRequests.append(PLACEHOLDERS.mediaId, index, range, input),
  );
  return {
    platform: "x",
    pending: true,
    steps: [
      xRequests.initialize(input.media, input),
      ...appends,
      xRequests.finalize(PLACEHOLDERS.mediaId, input),
    ],
  };
}

/** The requests `status` sends once processing succeeded. */
export function buildXFinish(
  request: VideoPublishRequest,
  mediaId: string,
  options: BuildOptions,
): PlatformRequest[] {
  return [xRequests.status(mediaId, options), xRequests.createPost(request, mediaId, options)];
}

export function validateXRequest(
  request: PublishRequest,
  media: MediaFacts | null,
): RequestIssue[] {
  return videoOnlyIssues(request, media, (video, facts) =>
    checkMedia(video, facts, X_VIDEO_LIMITS),
  );
}
