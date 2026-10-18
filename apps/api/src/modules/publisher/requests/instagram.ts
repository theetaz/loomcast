import {
  type InstagramPostOptions,
  MAX_POST_MEDIA,
  type MediaPublishRequest,
  type PublishMediaItem,
  type PublishRequest,
  platformSupportsFormat,
  type VideoPublishRequest,
} from "@loomcast/contracts";
import { countMentions, limitCaption, PLATFORM_CAPTION_LIMITS } from "../caption";
import {
  type BuildOptions,
  bearer,
  checkMedia,
  itemContainerPlaceholder,
  MB,
  type MediaFacts,
  PLACEHOLDERS,
  type PlanInput,
  type PlatformRequest,
  type PublishPlan,
  type RequestIssue,
  segment,
  unsupportedFormatMessage,
  videoPlanInput,
} from "./types";

// Instagram posts through the Graph API (Instagram API with Facebook Login). Every format is a
// container created from public media URLs (`POST /{ig-user-id}/media`), polled until FINISHED,
// then published (`POST /{ig-user-id}/media_publish {creation_id}`). The token goes in the
// Authorization header, as the platform's examples send it.
//
// From the content publishing guide and the IG User media reference (Graph API v26.0, confirmed
// 2026-10-18; https://developers.facebook.com/docs/instagram-platform/content-publishing and
// https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media):
// - Reels: `media_type=REELS`, `video_url`, `caption`, `share_to_feed` (Reels only), `cover_url`
//   or `thumb_offset` (the cover frame in ms; ignored when `cover_url` is set), `collaborators`
//   (up to 3 usernames) and `location_id` (a Page id with a location).
// - Photos: `image_url`, `caption`, `alt_text` (up to 1,000 characters; photos and carousel
//   photos only), `collaborators` and `location_id`. JPEG is the only format accepted (extended
//   JPEG such as MPO or JPS is not); at most 8 MB, 320 px wide or more, aspect ratio 4:5 to
//   1.91:1. The reference also lists a maximum width of 1,440 px; wider photos are not refused
//   here and are left to Instagram.
// - Carousels: up to 10 photos, videos or both. Each item is its own container with
//   `is_carousel_item=true` (`image_url`, or `media_type=VIDEO` with `video_url`) and no caption
//   or location; the carousel is a container with `media_type=CAROUSEL`, `children` (the item
//   container ids, comma-separated), `caption`, `collaborators` and `location_id`. A carousel
//   counts as one post against the publishing quota. Video items process asynchronously and must
//   be FINISHED before the carousel container is created (the guide does not say so; Meta answers
//   a carousel with unfinished items with a generic error), and the carousel container is then
//   polled like any other.
// - Stories: `media_type=STORIES` with `image_url` or `video_url`. Stories take no caption,
//   collaborators, location or stickers. Story photos: JPEG, at most 8 MB. Story videos: 3 to
//   60 s, at most 100 MB, aspect ratio 0.1:1 to 10:1.
// The reference gives no limits for carousel videos any more; the former feed video limits (3 to
// 60 s, 100 MB, the same as story videos) are applied. User tags and shopping tags are not sent.

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

/** The limits of one photo or video of a composed post. */
export interface InstagramItemLimits {
  readonly mimes: readonly string[];
  readonly maxBytes: number;
  readonly minWidth?: number;
  readonly minAspect?: number;
  readonly maxAspect?: number;
  readonly minDurationMs?: number;
  readonly maxDurationMs?: number;
}

/** Feed photos (single and carousel photos): JPEG, 8 MB, 320 px wide or more, 4:5 to 1.91:1. */
export const INSTAGRAM_IMAGE_LIMITS = {
  mimes: ["image/jpeg"],
  maxBytes: 8 * MB,
  minWidth: 320,
  minAspect: 4 / 5,
  maxAspect: 1.91,
} as const satisfies InstagramItemLimits;

/** Story photos: JPEG, 8 MB (9:16 recommended, not required). */
export const INSTAGRAM_STORY_IMAGE_LIMITS = {
  mimes: ["image/jpeg"],
  maxBytes: 8 * MB,
} as const satisfies InstagramItemLimits;

/** Story videos: MP4 or MOV, 3 to 60 s, 100 MB, aspect ratio 0.1:1 to 10:1. */
export const INSTAGRAM_STORY_VIDEO_LIMITS = {
  mimes: ["video/mp4", "video/quicktime"],
  maxBytes: 100 * MB,
  minAspect: 0.1,
  maxAspect: 10,
  minDurationMs: 3_000,
  maxDurationMs: 60_000,
} as const satisfies InstagramItemLimits;

/** Carousel videos: MP4 or MOV, 3 to 60 s, 100 MB (the former feed video limits). */
export const INSTAGRAM_CAROUSEL_VIDEO_LIMITS = {
  mimes: ["video/mp4", "video/quicktime"],
  maxBytes: 100 * MB,
  minDurationMs: 3_000,
  maxDurationMs: 60_000,
} as const satisfies InstagramItemLimits;

export const INSTAGRAM_CAROUSEL_MIN_ITEMS = 2;
export const INSTAGRAM_CAROUSEL_MAX_ITEMS = Math.min(10, MAX_POST_MEDIA);

function auth(options: BuildOptions): Record<string, string> {
  return { Authorization: bearer(options.accessToken) };
}

/** What the carousel container carries: the account, the caption and the options. */
export type CarouselParent = Pick<MediaPublishRequest, "externalId" | "caption" | "options">;

function instagramOptions(request: Pick<PublishRequest, "options">): InstagramPostOptions {
  return request.options?.instagram ?? {};
}

/** `collaborators` and `location_id` when the post sets them (Reels, photos and carousels). */
function feedOptions(
  request: Pick<PublishRequest, "options">,
): Record<string, string | readonly string[]> {
  const options = instagramOptions(request);
  return {
    ...(options.collaborators === undefined || options.collaborators.length === 0
      ? {}
      : { collaborators: options.collaborators }),
    ...(options.locationId === undefined ? {} : { location_id: options.locationId }),
  };
}

function altText(item: PublishMediaItem): Record<string, string> {
  return item.type === "image" && item.altText !== undefined && item.altText !== ""
    ? { alt_text: item.altText }
    : {};
}

function createRequest(
  step: string,
  igUserId: string,
  body: PlatformRequest["body"],
  options: BuildOptions,
): PlatformRequest {
  return {
    step,
    method: "POST",
    api: "graph",
    path: `/${segment(igUserId)}/media`,
    headers: auth(options),
    bodyEncoding: "json",
    ...(body === undefined ? {} : { body }),
  };
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

  /**
   * `POST /{ig-user-id}/media`: a Reels container from the public video URL. `share_to_feed`
   * defaults to true; without a poster, `thumb_offset` picks the cover frame when set.
   */
  createContainer(request: VideoPublishRequest, options: BuildOptions): PlatformRequest {
    const { shareToFeed, thumbOffsetMs } = instagramOptions(request);
    return createRequest(
      "create_container",
      request.externalId,
      {
        media_type: "REELS",
        video_url: request.videoUrl,
        caption: limitCaption("instagram", request.caption),
        share_to_feed: shareToFeed ?? true,
        ...(request.posterUrl === undefined
          ? thumbOffsetMs === undefined
            ? {}
            : { thumb_offset: thumbOffsetMs }
          : { cover_url: request.posterUrl }),
        ...feedOptions(request),
      },
      options,
    );
  },

  /** `POST /{ig-user-id}/media`: a photo container (`image_url`, no `media_type`). */
  createImageContainer(
    request: MediaPublishRequest,
    item: PublishMediaItem,
    options: BuildOptions,
  ): PlatformRequest {
    return createRequest(
      "create_container",
      request.externalId,
      {
        image_url: item.url,
        caption: limitCaption("instagram", request.caption),
        ...altText(item),
        ...feedOptions(request),
      },
      options,
    );
  },

  /** `POST /{ig-user-id}/media {media_type: STORIES}` with `image_url` or `video_url`. */
  createStoryContainer(
    request: MediaPublishRequest,
    item: PublishMediaItem,
    options: BuildOptions,
  ): PlatformRequest {
    return createRequest(
      "create_container",
      request.externalId,
      {
        media_type: "STORIES",
        ...(item.type === "image" ? { image_url: item.url } : { video_url: item.url }),
      },
      options,
    );
  },

  /** `POST /{ig-user-id}/media {is_carousel_item: true}`: one photo or video of a carousel. */
  createItemContainer(
    request: MediaPublishRequest,
    item: PublishMediaItem,
    options: BuildOptions,
  ): PlatformRequest {
    return createRequest(
      "create_item_container",
      request.externalId,
      item.type === "image"
        ? { is_carousel_item: true, image_url: item.url, ...altText(item) }
        : { is_carousel_item: true, media_type: "VIDEO", video_url: item.url },
      options,
    );
  },

  /**
   * `POST /{ig-user-id}/media {media_type: CAROUSEL, children}` once every item is FINISHED. It
   * needs no media URLs, so `status` can send it without copying the items again.
   */
  createCarouselContainer(
    request: CarouselParent,
    itemContainerIds: readonly string[],
    options: BuildOptions,
  ): PlatformRequest {
    return createRequest(
      "create_carousel_container",
      request.externalId,
      {
        media_type: "CAROUSEL",
        children: itemContainerIds.join(","),
        caption: limitCaption("instagram", request.caption),
        ...feedOptions(request),
      },
      options,
    );
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

  /** `GET /{media-id}?fields=permalink`. Stories may answer without one. */
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

/** `input` as a composed post's request. Throws for a video or text post (a caller's bug). */
function mediaRequestOf(input: PlanInput): MediaPublishRequest {
  const { request } = input;
  if (request.format !== "image" && request.format !== "carousel" && request.format !== "story") {
    throw new Error(unsupportedFormatMessage("instagram", request));
  }
  return request;
}

/** The first item of a composed post; the contract guarantees one. */
function firstItem(request: MediaPublishRequest): PublishMediaItem {
  const [item] = request.media;
  if (item === undefined) {
    throw new Error("a composed post has at least one item");
  }
  return item;
}

/**
 * What `publish` sends: the quota check, then the containers. Every container processes on the
 * platform, so the post is pending; `status` polls it, publishes it and reads the permalink.
 * - Reel, photo, story: one container (`create_container`).
 * - Carousel: one container per item (`create_item_container`), then the carousel container
 *   (`create_carousel_container`) naming the item containers, shown here as
 *   `itemContainerPlaceholder` ids. A carousel with videos creates it from `status` once the
 *   video items are FINISHED.
 */
export function buildInstagramPublish(input: PlanInput): PublishPlan {
  const limit = instagramRequests.publishingLimit(input.request.externalId, input);
  if (input.request.format === "reel") {
    const video = videoPlanInput(input);
    return {
      platform: "instagram",
      pending: true,
      steps: [limit, instagramRequests.createContainer(video.request, video)],
    };
  }
  const request = mediaRequestOf(input);
  let steps: PlatformRequest[];
  switch (request.format) {
    case "image":
      steps = [instagramRequests.createImageContainer(request, firstItem(request), input)];
      break;
    case "story":
      steps = [instagramRequests.createStoryContainer(request, firstItem(request), input)];
      break;
    case "carousel":
      steps = [
        ...request.media.map((item) => instagramRequests.createItemContainer(request, item, input)),
        instagramRequests.createCarouselContainer(
          request,
          request.media.map((_, index) => itemContainerPlaceholder(index)),
          input,
        ),
      ];
      break;
  }
  return { platform: "instagram", pending: true, steps: [limit, ...steps] };
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

/** Allowance for rounding in aspect ratios such as 1080×1350 (exactly 4:5). */
const ASPECT_TOLERANCE = 0.005;

function seconds(ms: number): string {
  return `${Math.round(ms / 100) / 10} s`;
}

/** What Instagram would refuse in one photo or video of a composed post. */
function itemIssues(
  item: PublishMediaItem,
  index: number,
  count: number,
  limits: InstagramItemLimits,
): RequestIssue[] {
  const field = `media.${index}`;
  const what = item.type === "image" ? "photo" : "video";
  const name = count === 1 ? `The ${what}` : `${what === "photo" ? "Photo" : "Video"} ${index + 1}`;
  const issues: RequestIssue[] = [];
  if (!limits.mimes.includes(item.mime)) {
    issues.push({
      field,
      message:
        item.type === "image"
          ? `Instagram publishes JPEG photos only; ${name.toLowerCase()} is ${item.mime}. Upload it as a JPEG.`
          : `${name} is ${item.mime}; Instagram takes MP4 or MOV videos.`,
    });
  }
  if (item.bytes > limits.maxBytes) {
    issues.push({ field, message: `${name} is larger than ${limits.maxBytes / MB} MB.` });
  }
  if (
    item.type === "video" &&
    item.durationMs !== null &&
    ((limits.minDurationMs !== undefined && item.durationMs < limits.minDurationMs) ||
      (limits.maxDurationMs !== undefined && item.durationMs > limits.maxDurationMs))
  ) {
    issues.push({
      field,
      message: `${name} runs ${seconds(item.durationMs)}; it must run ${seconds(limits.minDurationMs ?? 0)} to ${seconds(limits.maxDurationMs ?? 0)}.`,
    });
  }
  if (item.width !== null && limits.minWidth !== undefined && item.width < limits.minWidth) {
    issues.push({ field, message: `${name} must be at least ${limits.minWidth} pixels wide.` });
  }
  if (item.width !== null && item.height !== null) {
    const aspect = item.width / item.height;
    if (
      (limits.minAspect !== undefined && aspect < limits.minAspect - ASPECT_TOLERANCE) ||
      (limits.maxAspect !== undefined && aspect > limits.maxAspect + ASPECT_TOLERANCE)
    ) {
      issues.push({
        field,
        message:
          item.type === "image" && limits === INSTAGRAM_IMAGE_LIMITS
            ? `${name} is ${item.width}×${item.height}; Instagram takes photos from 4:5 (portrait) to 1.91:1 (landscape).`
            : `${name}'s aspect ratio is not accepted.`,
      });
    }
  }
  return issues;
}

function mentionIssues(caption: string): RequestIssue[] {
  const maxMentions = PLATFORM_CAPTION_LIMITS.instagram.maxMentions ?? Number.POSITIVE_INFINITY;
  return countMentions(caption) > maxMentions
    ? [{ field: "caption", message: `The caption mentions more than ${maxMentions} accounts.` }]
    : [];
}

function reelIssues(request: VideoPublishRequest, media: MediaFacts | null): RequestIssue[] {
  if (media === null) {
    return [{ field: "video", message: "The post has no video." }];
  }
  const issues = checkMedia(request, media, INSTAGRAM_REELS_LIMITS);
  const { thumbOffsetMs } = instagramOptions(request);
  if (
    request.posterUrl === undefined &&
    thumbOffsetMs !== undefined &&
    thumbOffsetMs >= request.durationMs
  ) {
    issues.push({ field: "options", message: "The cover frame is past the end of the video." });
  }
  return issues;
}

function composedIssues(request: MediaPublishRequest): RequestIssue[] {
  const { media } = request;
  const issues: RequestIssue[] = [];
  switch (request.format) {
    case "image": {
      if (media.length !== 1) {
        issues.push({ field: "media", message: "An Instagram photo post carries one photo." });
      }
      media.forEach((item, index) => {
        issues.push(
          ...(item.type === "image"
            ? itemIssues(item, index, media.length, INSTAGRAM_IMAGE_LIMITS)
            : [{ field: `media.${index}`, message: "An Instagram photo post carries a photo." }]),
        );
      });
      break;
    }
    case "carousel": {
      if (
        media.length < INSTAGRAM_CAROUSEL_MIN_ITEMS ||
        media.length > INSTAGRAM_CAROUSEL_MAX_ITEMS
      ) {
        issues.push({
          field: "media",
          message: `An Instagram carousel carries ${INSTAGRAM_CAROUSEL_MIN_ITEMS} to ${INSTAGRAM_CAROUSEL_MAX_ITEMS} photos or videos.`,
        });
      }
      media.forEach((item, index) => {
        issues.push(
          ...itemIssues(
            item,
            index,
            media.length,
            item.type === "image" ? INSTAGRAM_IMAGE_LIMITS : INSTAGRAM_CAROUSEL_VIDEO_LIMITS,
          ),
        );
      });
      break;
    }
    case "story": {
      if (media.length !== 1) {
        issues.push({ field: "media", message: "An Instagram story carries one photo or video." });
      }
      media.forEach((item, index) => {
        issues.push(
          ...itemIssues(
            item,
            index,
            media.length,
            item.type === "image" ? INSTAGRAM_STORY_IMAGE_LIMITS : INSTAGRAM_STORY_VIDEO_LIMITS,
          ),
        );
      });
      const options = instagramOptions(request);
      if (options.collaborators !== undefined && options.collaborators.length > 0) {
        issues.push({ field: "options", message: "Instagram stories take no collaborators." });
      }
      if (options.locationId !== undefined) {
        issues.push({ field: "options", message: "Instagram stories take no location." });
      }
      break;
    }
  }
  return issues;
}

/**
 * What Instagram would refuse in `request` (pure). `media` holds the facts of a Reel's video;
 * composed posts carry theirs in `request.media`. Stories are sent without a caption, so their
 * caption is not checked.
 */
export function validateInstagramRequest(
  request: PublishRequest,
  media: MediaFacts | null,
): RequestIssue[] {
  if (!platformSupportsFormat("instagram", request.format)) {
    return [{ field: "format", message: unsupportedFormatMessage("instagram", request) }];
  }
  switch (request.format) {
    case "reel":
      return [...reelIssues(request, media), ...mentionIssues(request.caption)];
    case "image":
    case "carousel":
      return [...composedIssues(request), ...mentionIssues(request.caption)];
    case "story":
      return composedIssues(request);
    default:
      return [{ field: "format", message: unsupportedFormatMessage("instagram", request) }];
  }
}
