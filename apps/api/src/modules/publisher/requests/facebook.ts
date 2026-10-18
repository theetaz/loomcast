import {
  type MediaPublishRequest,
  type PublishMediaItem,
  type PublishRequest,
  platformSupportsFormat,
  type TextPublishRequest,
  type VideoPublishRequest,
} from "@loomcast/contracts";
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
  photoPlaceholder,
  type RequestIssue,
  segment,
  unsupportedFormatMessage,
  videoPlanInput,
} from "./types";

// Facebook Page posts, by format. Confirmed against the Graph API v26.0 references and guides on
// 2026-10-18:
// - Page Reels (`reel`): start an upload session on `/{page-id}/video_reels`, let the upload host
//   fetch the public video URL, then finish with `video_state: PUBLISHED`. The video processes
//   afterwards, so the post is pending until `status` reports it published.
// - Videos (`video`): `POST /{page-id}/videos {file_url, description, title}` returns `{id}`; the
//   video then processes and reports the same `status` phases as a Reel (pending).
//   https://developers.facebook.com/docs/graph-api/reference/page/videos/
// - Photos (`image`): `POST /{page-id}/photos {url, caption, alt_text_custom}` publishes at once
//   and returns `{id, post_id}`. JPEG, BMP, PNG, GIF or TIFF, at most 4 MB (PNG under 1 MB to
//   avoid pixelation). https://developers.facebook.com/docs/graph-api/reference/page/photos/
// - Multi-photo posts (`carousel`, photos only): each photo goes to `/{page-id}/photos` with
//   `published=false`, then `POST /{page-id}/feed {message, attached_media[n]={"media_fbid"}}`
//   returns `{id}` ("Publishing a multi-photo post with uploaded photos" in the Page Photos
//   reference). `temporary` is only for scheduled posts, so it is not sent.
// - Text and link posts (`text`): `POST /{page-id}/feed {message, link}` returns `{id}`; one of
//   the two is required. https://developers.facebook.com/docs/pages-api/posts and
//   https://developers.facebook.com/docs/graph-api/reference/page/feed/
// - Stories (`story`): a photo goes to `/{page-id}/photos` with `published=false`, then
//   `POST /{page-id}/photo_stories {photo_id}` returns `{success, post_id}`; a video goes through
//   `/{page-id}/video_stories` start, upload host and finish (`{success, post_id}`), then
//   processes. `GET /{page-id}/stories` lists each story's `post_id`, `url`, `status`,
//   `creation_time` and `media_type`. https://developers.facebook.com/docs/page-stories-api
// Feed and photo posts publish synchronously; the post's permalink then comes from
// `GET /{post-id}?fields=permalink_url` (or, for a story, from the Page's stories).
// Every call takes a Page token of someone with the CREATE_CONTENT task and `pages_manage_posts`,
// `pages_read_engagement` and `pages_show_list`.

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

/**
 * Page video limits. The v26.0 references state none; the last documented limits of an upload by
 * URL (1 GB and 20 minutes, from the retired v2 video upload guide) are kept as the bound.
 */
export const FACEBOOK_VIDEO_LIMITS = {
  minDurationMs: 1_000,
  maxDurationMs: 20 * 60_000,
  maxBytes: 1_024 * MB,
  mimes: ["video/mp4", "video/quicktime"],
} as const;

/**
 * Video story limits from the Page Stories guide: 3 to 60 s (the media spec says 90 s, the
 * limitations section 60 s), 9:16, at least 540×960. No file size is given; 1 GB as for Reels.
 */
export const FACEBOOK_VIDEO_STORY_LIMITS = {
  minDurationMs: 3_000,
  maxDurationMs: 60_000,
  maxBytes: 1_024 * MB,
  minWidth: 540,
  minHeight: 960,
  minAspect: 0.5,
  maxAspect: 0.6,
  mimes: ["video/mp4", "video/quicktime"],
} as const;

/**
 * Photo limits from the Page Photos reference: at most 4 MB (the Stories guide allows 10 MB, but
 * a story photo is uploaded through the same edge). Of the types posts carry, JPEG and PNG are
 * accepted; WebP is not on the platform's list.
 */
export const FACEBOOK_PHOTO_LIMITS = {
  maxBytes: 4 * MB,
  mimes: ["image/jpeg", "image/png"],
} as const;

function auth(options: BuildOptions): Record<string, string> {
  return { Authorization: bearer(options.accessToken) };
}

/** The caption cut to Facebook's limit, as a post's `message` or a photo's `caption`; may be empty. */
export function facebookMessage(request: PublishRequest): string {
  return limitCaption("facebook", request.caption).trim();
}

/** The Graph fields `recentPosts` reads to recognise a post. */
export const FACEBOOK_RECENT_POST_FIELDS =
  "id,message,created_time,permalink_url,attachments{subattachments{target{id}}}";

/** The Graph fields `stories` reads. */
export const FACEBOOK_STORY_FIELDS = "post_id,url,status,creation_time,media_type";

export const facebookRequests = {
  /**
   * `POST /{page-id}/video_reels` (or `video_stories`) `{upload_phase: "start"}` returns
   * `{video_id, upload_url}`.
   */
  startUpload(
    pageId: string,
    options: BuildOptions,
    edge: "video_reels" | "video_stories" = "video_reels",
  ): PlatformRequest {
    return {
      step: "start_upload",
      method: "POST",
      api: "graph",
      path: `/${segment(pageId)}/${edge}`,
      headers: auth(options),
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
  finishUpload(
    request: VideoPublishRequest,
    videoId: string,
    options: BuildOptions,
  ): PlatformRequest {
    return {
      step: "finish_upload",
      method: "POST",
      api: "graph",
      path: `/${segment(request.externalId)}/video_reels`,
      headers: auth(options),
      bodyEncoding: "json",
      body: {
        upload_phase: "finish",
        video_id: videoId,
        video_state: "PUBLISHED",
        description: limitCaption("facebook", request.caption),
      },
    };
  },

  /** `POST /{page-id}/video_stories {upload_phase: "finish", video_id}` → `{success, post_id}`. */
  finishStoryUpload(pageId: string, videoId: string, options: BuildOptions): PlatformRequest {
    return {
      step: "finish_upload",
      method: "POST",
      api: "graph",
      path: `/${segment(pageId)}/video_stories`,
      headers: auth(options),
      bodyEncoding: "json",
      body: { upload_phase: "finish", video_id: videoId },
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
      headers: auth(options),
    };
  },

  /**
   * `POST /{page-id}/videos {file_url, description, title}` → `{id}`: the platform fetches the
   * public video and publishes it once processed.
   */
  uploadVideo(request: VideoPublishRequest, options: BuildOptions): PlatformRequest {
    const title = request.options?.facebook?.title;
    return {
      step: "upload_video",
      method: "POST",
      api: "graph",
      path: `/${segment(request.externalId)}/videos`,
      headers: auth(options),
      bodyEncoding: "json",
      body: {
        file_url: request.videoUrl,
        description: limitCaption("facebook", request.caption),
        ...(title === undefined ? {} : { title }),
      },
    };
  },

  /**
   * `POST /{page-id}/photos {url}` → `{id, post_id}`. Published (the default) with `caption`, it
   * is a photo post; with `published: false` it is a photo for a multi-photo post or a story.
   */
  uploadPhoto(
    pageId: string,
    item: PublishMediaItem,
    photo: { caption?: string; published: boolean },
    options: BuildOptions,
  ): PlatformRequest {
    const altText = item.altText?.trim() ?? "";
    return {
      step: "upload_photo",
      method: "POST",
      api: "graph",
      path: `/${segment(pageId)}/photos`,
      headers: auth(options),
      bodyEncoding: "json",
      body: {
        url: item.url,
        ...(photo.caption === undefined || photo.caption === "" ? {} : { caption: photo.caption }),
        ...(altText === "" ? {} : { alt_text_custom: altText }),
        ...(photo.published ? {} : { published: false }),
      },
    };
  },

  /**
   * `POST /{page-id}/feed {message, link, attached_media[n]}` → `{id}`: a text or link post, or
   * a multi-photo post of the unpublished `photoIds`, in order.
   */
  createPost(
    request: TextPublishRequest | MediaPublishRequest,
    photoIds: readonly string[],
    options: BuildOptions,
  ): PlatformRequest {
    const message = facebookMessage(request);
    const link = request.format === "text" ? request.options?.facebook?.link : undefined;
    const attached: Record<string, string> = {};
    photoIds.forEach((id, index) => {
      attached[`attached_media[${index}]`] = JSON.stringify({ media_fbid: id });
    });
    return {
      step: "create_post",
      method: "POST",
      api: "graph",
      path: `/${segment(request.externalId)}/feed`,
      headers: auth(options),
      bodyEncoding: "json",
      body: {
        ...(message === "" ? {} : { message }),
        ...(link === undefined ? {} : { link }),
        ...attached,
      },
    };
  },

  /** `POST /{page-id}/photo_stories {photo_id}` → `{success, post_id}`. */
  photoStory(pageId: string, photoId: string, options: BuildOptions): PlatformRequest {
    return {
      step: "publish_story",
      method: "POST",
      api: "graph",
      path: `/${segment(pageId)}/photo_stories`,
      headers: auth(options),
      bodyEncoding: "json",
      body: { photo_id: photoId },
    };
  },

  /** `GET /{post-id}?fields=permalink_url`: the link of a published post. */
  permalink(postId: string, options: BuildOptions): PlatformRequest {
    return {
      step: "permalink",
      method: "GET",
      api: "graph",
      path: `/${segment(postId)}`,
      query: { fields: "permalink_url" },
      headers: auth(options),
    };
  },

  /** `GET /{page-id}/stories`: the Page's stories, newest first, with their links. */
  stories(pageId: string, options: BuildOptions): PlatformRequest {
    return {
      step: "stories",
      method: "GET",
      api: "graph",
      path: `/${segment(pageId)}/stories`,
      query: { fields: FACEBOOK_STORY_FIELDS, limit: "10" },
      headers: auth(options),
    };
  },

  /**
   * `GET /{page-id}/feed`: the Page's latest posts, read only after a publishing call was lost in
   * transit, to tell whether it took effect.
   */
  recentPosts(pageId: string, options: BuildOptions): PlatformRequest {
    return {
      step: "recent_posts",
      method: "GET",
      api: "graph",
      path: `/${segment(pageId)}/feed`,
      query: { fields: FACEBOOK_RECENT_POST_FIELDS, limit: "10" },
      headers: auth(options),
    };
  },
};

/** The single photo or video of a story. */
function storyItem(request: MediaPublishRequest): PublishMediaItem {
  const [item] = request.media;
  if (item === undefined) {
    throw new Error("a story carries one photo or video");
  }
  return item;
}

/**
 * What `publish` sends, by format. Ids the platform returns appear as `PLACEHOLDERS` (photos of a
 * multi-photo post as `photoPlaceholder(n)`). Reels, videos and video stories then wait for
 * processing (pending); photo, multi-photo, text posts and photo stories publish at once.
 */
export function buildFacebookPublish(plan: PlanInput): PublishPlan {
  const { request } = plan;
  const pageId = request.externalId;
  switch (request.format) {
    case "reel": {
      const input = videoPlanInput(plan);
      return {
        platform: "facebook",
        pending: true,
        steps: [
          facebookRequests.startUpload(pageId, input),
          facebookRequests.uploadFromUrl(PLACEHOLDERS.videoId, input.request.videoUrl, input),
          facebookRequests.finishUpload(input.request, PLACEHOLDERS.videoId, input),
        ],
      };
    }
    case "video": {
      const input = videoPlanInput(plan);
      return {
        platform: "facebook",
        pending: true,
        steps: [facebookRequests.uploadVideo(input.request, input)],
      };
    }
    case "image": {
      const [item] = request.media;
      if (item === undefined) {
        throw new Error("a photo post carries one photo");
      }
      return {
        platform: "facebook",
        pending: false,
        steps: [
          facebookRequests.uploadPhoto(
            pageId,
            item,
            { caption: facebookMessage(request), published: true },
            plan,
          ),
          facebookRequests.permalink(PLACEHOLDERS.postId, plan),
        ],
      };
    }
    case "carousel": {
      const photoIds = request.media.map((_, index) => photoPlaceholder(index));
      return {
        platform: "facebook",
        pending: false,
        steps: [
          ...request.media.map((item) =>
            facebookRequests.uploadPhoto(pageId, item, { published: false }, plan),
          ),
          facebookRequests.createPost(request, photoIds, plan),
          facebookRequests.permalink(PLACEHOLDERS.postId, plan),
        ],
      };
    }
    case "story": {
      const item = storyItem(request);
      if (item.type === "video") {
        return {
          platform: "facebook",
          pending: true,
          steps: [
            facebookRequests.startUpload(pageId, plan, "video_stories"),
            facebookRequests.uploadFromUrl(PLACEHOLDERS.videoId, item.url, plan),
            facebookRequests.finishStoryUpload(pageId, PLACEHOLDERS.videoId, plan),
          ],
        };
      }
      return {
        platform: "facebook",
        pending: false,
        steps: [
          facebookRequests.uploadPhoto(pageId, item, { published: false }, plan),
          facebookRequests.photoStory(pageId, PLACEHOLDERS.photoId, plan),
          facebookRequests.stories(pageId, plan),
        ],
      };
    }
    case "text":
      return {
        platform: "facebook",
        pending: false,
        steps: [
          facebookRequests.createPost(request, [], plan),
          facebookRequests.permalink(PLACEHOLDERS.postId, plan),
        ],
      };
  }
}

/** Why the platform would refuse the photo at `field`; empty when it would take it. */
function photoIssues(item: PublishMediaItem, field: string): RequestIssue[] {
  const issues: RequestIssue[] = [];
  if (!(FACEBOOK_PHOTO_LIMITS.mimes as readonly string[]).includes(item.mime)) {
    issues.push({
      field,
      message: `Facebook does not accept ${item.mime} photos; use JPEG or PNG.`,
    });
  }
  if (item.bytes > FACEBOOK_PHOTO_LIMITS.maxBytes) {
    issues.push({
      field,
      message: `The photo is larger than ${FACEBOOK_PHOTO_LIMITS.maxBytes / MB} MB.`,
    });
  }
  return issues;
}

/** Why the platform would refuse a story's video; the dimensions are checked when known. */
function storyVideoIssues(item: PublishMediaItem): RequestIssue[] {
  if (item.durationMs === null) {
    return [{ field: "media.0", message: "The story video has no duration." }];
  }
  const { minWidth, minHeight, minAspect, maxAspect, ...limits } = FACEBOOK_VIDEO_STORY_LIMITS;
  const known = item.width !== null && item.height !== null;
  return checkMedia(
    { durationMs: item.durationMs, width: item.width ?? 1, height: item.height ?? 1 },
    { bytes: item.bytes, mime: item.mime },
    known ? { ...limits, minWidth, minHeight, minAspect, maxAspect } : limits,
  );
}

export function validateFacebookRequest(
  request: PublishRequest,
  media: MediaFacts | null,
): RequestIssue[] {
  if (!platformSupportsFormat("facebook", request.format)) {
    return [{ field: "format", message: unsupportedFormatMessage("facebook", request) }];
  }
  switch (request.format) {
    case "reel":
    case "video": {
      if (media === null) {
        return [{ field: "video", message: "The post has no video." }];
      }
      return checkMedia(
        request,
        media,
        request.format === "reel" ? FACEBOOK_REELS_LIMITS : FACEBOOK_VIDEO_LIMITS,
      );
    }
    case "image":
      if (request.media.length !== 1 || request.media[0]?.type !== "image") {
        return [{ field: "media", message: "A Facebook photo post carries one photo." }];
      }
      return photoIssues(request.media[0], "media.0");
    case "carousel": {
      if (request.media.some((item) => item.type !== "image")) {
        return [
          {
            field: "media",
            message:
              "A Facebook multi-photo post takes photos only; post a video on its own as a video or a Reel.",
          },
        ];
      }
      if (request.media.length < 2) {
        return [
          { field: "media", message: "A Facebook multi-photo post needs at least 2 photos." },
        ];
      }
      return request.media.flatMap((item, index) => photoIssues(item, `media.${index}`));
    }
    case "story": {
      const [item] = request.media;
      if (request.media.length !== 1 || item === undefined) {
        return [{ field: "media", message: "A Facebook story carries one photo or video." }];
      }
      return item.type === "image" ? photoIssues(item, "media.0") : storyVideoIssues(item);
    }
    case "text": {
      if (facebookMessage(request) === "" && request.options?.facebook?.link === undefined) {
        return [{ field: "caption", message: "A Facebook text post needs a caption or a link." }];
      }
      return [];
    }
  }
}
