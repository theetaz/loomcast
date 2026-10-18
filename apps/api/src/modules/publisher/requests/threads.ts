import type { PublishRequest, VideoPublishRequest } from "@loomcast/contracts";
import { limitCaption } from "../caption";
import {
  type BuildOptions,
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

// Threads video posts: a VIDEO container from the public URL, polled until FINISHED, then
// published. The Threads API takes the token as the `access_token` parameter: in the query of
// GET requests and in the form body of POST requests.

/** Threads video limits from the platform's guide: up to 5 min, 1 GB, at most 1920 px wide. */
export const THREADS_VIDEO_LIMITS = {
  minDurationMs: 1,
  maxDurationMs: 5 * 60_000,
  maxBytes: 1_024 * MB,
  maxWidth: 1_920,
  minAspect: 0.01,
  maxAspect: 10,
  mimes: ["video/mp4", "video/quicktime"],
} as const;

export const threadsRequests = {
  /** `GET /{threads-user-id}/threads_publishing_limit`: the 24-hour quota. */
  publishingLimit(userId: string, options: BuildOptions): PlatformRequest {
    return {
      step: "publishing_limit",
      method: "GET",
      api: "threads",
      path: `/${segment(userId)}/threads_publishing_limit`,
      query: { fields: "quota_usage,config", access_token: options.accessToken },
    };
  },

  /** `POST /{threads-user-id}/threads {media_type: "VIDEO", video_url, text}`. */
  createContainer(request: VideoPublishRequest, options: BuildOptions): PlatformRequest {
    return {
      step: "create_container",
      method: "POST",
      api: "threads",
      path: `/${segment(request.externalId)}/threads`,
      bodyEncoding: "form",
      body: {
        media_type: "VIDEO",
        video_url: request.videoUrl,
        text: limitCaption("threads", request.caption),
        access_token: options.accessToken,
      },
    };
  },

  /** `GET /{container-id}?fields=status,error_message`. */
  containerStatus(containerId: string, options: BuildOptions): PlatformRequest {
    return {
      step: "container_status",
      method: "GET",
      api: "threads",
      path: `/${segment(containerId)}`,
      query: { fields: "status,error_message", access_token: options.accessToken },
    };
  },

  /** `POST /{threads-user-id}/threads_publish {creation_id}`. */
  publishContainer(userId: string, containerId: string, options: BuildOptions): PlatformRequest {
    return {
      step: "threads_publish",
      method: "POST",
      api: "threads",
      path: `/${segment(userId)}/threads_publish`,
      bodyEncoding: "form",
      body: { creation_id: containerId, access_token: options.accessToken },
    };
  },

  /** `GET /{media-id}?fields=permalink`. */
  permalink(mediaId: string, options: BuildOptions): PlatformRequest {
    return {
      step: "permalink",
      method: "GET",
      api: "threads",
      path: `/${segment(mediaId)}`,
      query: { fields: "permalink", access_token: options.accessToken },
    };
  },
};

/** What `publish` sends: the quota check, then the container. Then it waits (pending). */
export function buildThreadsPublish(plan: PlanInput): PublishPlan {
  const input = videoPlanInput(plan);
  return {
    platform: "threads",
    pending: true,
    steps: [
      threadsRequests.publishingLimit(input.request.externalId, input),
      threadsRequests.createContainer(input.request, input),
    ],
  };
}

/** The requests `status` sends once the container is FINISHED. */
export function buildThreadsFinish(
  userId: string,
  containerId: string,
  options: BuildOptions,
): PlatformRequest[] {
  return [
    threadsRequests.containerStatus(containerId, options),
    threadsRequests.publishContainer(userId, containerId, options),
    threadsRequests.permalink(PLACEHOLDERS.mediaId, options),
  ];
}

export function validateThreadsRequest(
  request: PublishRequest,
  media: MediaFacts | null,
): RequestIssue[] {
  return videoOnlyIssues(request, media, (video, facts) =>
    checkMedia(video, facts, THREADS_VIDEO_LIMITS),
  );
}
