import type { PublishRequest } from "@loomcast/contracts";
import { countMentions, limitCaption, PLATFORM_CAPTION_LIMITS } from "../caption";
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

// Instagram Reels through the Graph API (Instagram API with Facebook Login): a container from a
// public video URL, polled until FINISHED, then published. The token goes in the Authorization
// header, as the platform's examples send it.

/** Reels limits from the platform's reference: 3 s to 15 min, 300 MB, at most 1920 px wide. */
export const INSTAGRAM_REELS_LIMITS = {
  minDurationMs: 3_000,
  maxDurationMs: 15 * 60_000,
  maxBytes: 300 * MB,
  maxWidth: 1_920,
  minAspect: 0.01,
  maxAspect: 10,
  mimes: ["video/mp4", "video/quicktime"],
} as const;

function auth(options: BuildOptions): Record<string, string> {
  return { Authorization: bearer(options.accessToken) };
}

export const instagramRequests = {
  /** `GET /{ig-user-id}/content_publishing_limit`: the 24-hour quota, checked before posting. */
  publishingLimit(igUserId: string, options: BuildOptions): PlatformRequest {
    return {
      step: "publishing_limit",
      method: "GET",
      api: "graph",
      path: `/${segment(igUserId)}/content_publishing_limit`,
      query: { fields: "quota_usage,config" },
      headers: auth(options),
    };
  },

  /** `POST /{ig-user-id}/media`: a Reels container from the public video URL. */
  createContainer(request: PublishRequest, options: BuildOptions): PlatformRequest {
    return {
      step: "create_container",
      method: "POST",
      api: "graph",
      path: `/${segment(request.externalId)}/media`,
      headers: auth(options),
      bodyEncoding: "json",
      body: {
        media_type: "REELS",
        video_url: request.videoUrl,
        caption: limitCaption("instagram", request.caption),
        share_to_feed: true,
        ...(request.posterUrl === undefined ? {} : { cover_url: request.posterUrl }),
      },
    };
  },

  /** `GET /{container-id}?fields=status_code,status`: IN_PROGRESS, FINISHED, ERROR, EXPIRED. */
  containerStatus(containerId: string, options: BuildOptions): PlatformRequest {
    return {
      step: "container_status",
      method: "GET",
      api: "graph",
      path: `/${segment(containerId)}`,
      query: { fields: "status_code,status" },
      headers: auth(options),
    };
  },

  /** `POST /{ig-user-id}/media_publish {creation_id}`: publishes a FINISHED container. */
  publishContainer(igUserId: string, containerId: string, options: BuildOptions): PlatformRequest {
    return {
      step: "media_publish",
      method: "POST",
      api: "graph",
      path: `/${segment(igUserId)}/media_publish`,
      headers: auth(options),
      bodyEncoding: "json",
      body: { creation_id: containerId },
    };
  },

  /** `GET /{media-id}?fields=permalink`. */
  permalink(mediaId: string, options: BuildOptions): PlatformRequest {
    return {
      step: "permalink",
      method: "GET",
      api: "graph",
      path: `/${segment(mediaId)}`,
      query: { fields: "permalink" },
      headers: auth(options),
    };
  },
};

/**
 * What `publish` sends: the quota check, then the container. The container processes on the
 * platform, so the post is pending; `status` polls it, publishes it and reads the permalink.
 */
export function buildInstagramPublish(input: PlanInput): PublishPlan {
  return {
    platform: "instagram",
    pending: true,
    steps: [
      instagramRequests.publishingLimit(input.request.externalId, input),
      instagramRequests.createContainer(input.request, input),
    ],
  };
}

/** The requests `status` sends once the container is FINISHED. */
export function buildInstagramFinish(
  igUserId: string,
  containerId: string,
  options: BuildOptions,
): PlatformRequest[] {
  return [
    instagramRequests.containerStatus(containerId, options),
    instagramRequests.publishContainer(igUserId, containerId, options),
    instagramRequests.permalink(PLACEHOLDERS.mediaId, options),
  ];
}

export function validateInstagramRequest(
  request: PublishRequest,
  media: MediaFacts,
): RequestIssue[] {
  const issues = checkMedia(request, media, INSTAGRAM_REELS_LIMITS);
  const maxMentions = PLATFORM_CAPTION_LIMITS.instagram.maxMentions ?? Number.POSITIVE_INFINITY;
  if (countMentions(request.caption) > maxMentions) {
    issues.push({
      field: "caption",
      message: `The caption mentions more than ${maxMentions} accounts.`,
    });
  }
  return issues;
}
