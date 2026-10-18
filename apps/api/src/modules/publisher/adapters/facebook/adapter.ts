import type {
  JsonObject,
  MediaPublishRequest,
  TextPublishRequest,
  VideoPublishRequest,
} from "@loomcast/contracts";
import { z } from "zod";
import {
  createMetaGraphClient,
  type GraphClient,
  MetaGraphError,
  parseGraph,
} from "../../../../lib/meta-graph";
import { PublishFailure } from "../../errors";
import { videoFacts, videoOf } from "../../media";
import {
  buildFacebookPublish,
  facebookMessage,
  facebookRequests,
  validateFacebookRequest,
} from "../../requests/facebook";
import { isVideoRequest, type PlatformRequest } from "../../requests/types";
import type {
  AdapterIssue,
  PublishContext,
  PublisherAdapter,
  PublishMedia,
  PublishResult,
  StatusResult,
} from "../../types";
import {
  clientOptions,
  credentialsOf,
  type MetaAdapterOptions,
  metaCall,
  toGraphRequest,
} from "./meta-call";
import {
  type FacebookFeedPost,
  FacebookFeedSchema,
  type FacebookStories,
  FacebookStoriesSchema,
  type FacebookStory,
  findSentPhotoStory,
  findSentPost,
  storyByPostId,
} from "./recover";
import { createRuploadClient, RUPLOAD_BASE_URL } from "./rupload";
import {
  type FacebookVideo,
  type FacebookVideoKind,
  FacebookVideoSchema,
  facebookPostPermalink,
  facebookStatusOf,
  finishTookEffect,
} from "./status";

// The live Facebook Page adapter. `publish` sends what `buildFacebookPublish` builds, by format:
// - Reel: `POST /{page-id}/video_reels {upload_phase: "start"}` → `{video_id, upload_url}`;
//   `POST rupload.facebook.com/video-upload/<version>/{video-id}` with `Authorization: OAuth` and
//   `file_url` (the public copy of the render), so the upload host fetches the video;
//   `POST /{page-id}/video_reels {upload_phase: "finish", video_id, video_state: "PUBLISHED",
//   description}`. Pending until processed.
// - Video: `POST /{page-id}/videos {file_url, description, title}` → `{id}`. Pending.
// - Photo: `POST /{page-id}/photos {url, caption, alt_text_custom}` → `{id, post_id}`, then
//   `GET /{post-id}?fields=permalink_url`. Published at once.
// - Multi-photo post: each photo `POST /{page-id}/photos {url, published: false}`, then
//   `POST /{page-id}/feed {message, attached_media[n]}` → `{id}` and the permalink. Published at
//   once.
// - Text post: `POST /{page-id}/feed {message, link}` → `{id}` and the permalink.
// - Photo story: the photo unpublished, then `POST /{page-id}/photo_stories {photo_id}` →
//   `{success, post_id}`, and the story's `url` from `GET /{page-id}/stories`. Published at once.
// - Video story: start, upload and finish on `/{page-id}/video_stories`, like a Reel. Pending.
// `status` reads `GET /{video-id}?fields=status,permalink_url` until a video's publishing phase
// completes. The post keeps one container id (the video or photo uploaded) and one external id
// (the video of a Reel or Page video, otherwise the Page post or story post).
//
// Double posts: the Graph client never retries a POST, and a publishing call that fails in
// transit is checked before the scheduler retries it. A lost Reel or video story finish is
// checked through the video's status; a lost feed post, photo post or photo story through the
// Page's latest posts or stories (`recover.ts`). When the call cannot be checked (a Page video, a
// photo or text post without a caption), the failure is not retried, so the owner looks at the
// Page first. A retried multi-photo post uploads its photos again: photos uploaded unpublished
// by the failed attempt stay unpublished, never shown on the Page.

const GraphId = z.union([z.string().min(1), z.number()]).transform(String);

const StartSchema = z.object({
  video_id: GraphId,
  upload_url: z.string().optional(),
});

const SuccessSchema = z.object({ success: z.boolean().optional() });
const IdSchema = z.object({ id: GraphId });
const PhotoSchema = z.object({ id: GraphId, post_id: GraphId.optional() });
const StoryPostSchema = z.object({ success: z.boolean().optional(), post_id: GraphId.optional() });
const PermalinkFieldSchema = z.object({ permalink_url: z.string().optional() });

/** Which kind of video a post's `status` reads; null for posts published at once. */
function videoKindOf(media: PublishMedia): FacebookVideoKind | null {
  switch (media.format) {
    case "reel":
      return "reel";
    case "video":
      return "video";
    case "story":
      return media.items[0]?.type === "video" ? "story" : null;
    default:
      return null;
  }
}

/** The live Facebook Page adapter with `options`. */
export function createFacebookAdapter(options: MetaAdapterOptions): PublisherAdapter {
  const meta = options.platforms.meta;
  const graph: GraphClient = createMetaGraphClient(options.platforms, clientOptions(options));
  const rupload = createRuploadClient({
    baseUrl: `${(options.ruploadBaseUrl ?? RUPLOAD_BASE_URL).replace(/\/+$/, "")}/${options.platforms.metaGraphVersion}`,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });

  function requireApp(): void {
    if (meta === null) {
      throw PublishFailure.of(
        "not_configured",
        "The Meta app is not configured, so Facebook posts cannot be signed.",
        { retryable: false },
      );
    }
  }

  /** Sends one Graph API step and reads its answer with `schema`. */
  async function call<S extends z.ZodType>(
    context: PublishContext,
    step: PlatformRequest,
    accessToken: string,
    schema: S,
    what: string,
  ): Promise<z.output<S>> {
    return metaCall(context, options, step.step, async () =>
      parseGraph(
        schema,
        await graph.request(toGraphRequest(step, accessToken, context.signal)),
        what,
      ),
    );
  }

  async function readVideo(
    context: PublishContext,
    step: PlatformRequest,
    accessToken: string,
  ): Promise<FacebookVideo> {
    return call(context, step, accessToken, FacebookVideoSchema, "the video status");
  }

  /** Whether `error` is a failure in transit of a call that may still have taken effect. */
  function lostInTransit(context: PublishContext, error: unknown): error is PublishFailure {
    return (
      error instanceof PublishFailure && error.error.code === "transient" && !context.signal.aborted
    );
  }

  /** `error` of a lost call that cannot be checked, made final so a retry cannot post twice. */
  function unconfirmed(error: PublishFailure, what: string): PublishFailure {
    return new PublishFailure({
      ...error.error,
      retryable: false,
      message: `${what} failed in transit and may have published the post; check the Page before publishing it again.`,
    });
  }

  /** After a `finish` that failed in transit: did it take effect anyway? */
  async function finishedAnyway(
    context: PublishContext,
    videoId: string,
    accessToken: string,
  ): Promise<boolean> {
    try {
      const video = await readVideo(
        context,
        facebookRequests.videoStatus(videoId, { accessToken }),
        accessToken,
      );
      return finishTookEffect(video);
    } catch (error) {
      if (context.signal.aborted) {
        throw error;
      }
      return false;
    }
  }

  /**
   * A best-effort read: the lookup after a lost call, or the permalink of a post already live.
   * Its failures are logged and give null. They are not reported as refused credentials: the post
   * did not fail on them, and reading the Page's feed may need a permission publishing does not.
   */
  async function lookup<S extends z.ZodType>(
    context: PublishContext,
    step: PlatformRequest,
    accessToken: string,
    schema: S,
    what: string,
  ): Promise<z.output<S> | null> {
    try {
      return parseGraph(
        schema,
        await graph.request(toGraphRequest(step, accessToken, context.signal)),
        what,
      );
    } catch (error) {
      context.logger.warn(
        { ...(error instanceof MetaGraphError ? error.toLog() : {}), step: step.step },
        `could not read ${what}`,
      );
      return null;
    }
  }

  /** After a feed or photo post that failed in transit: the post it created, if any. */
  async function postedAnyway(
    context: PublishContext,
    pageId: string,
    sent: { message: string; photoIds?: readonly string[] },
    accessToken: string,
  ): Promise<FacebookFeedPost | null> {
    const feed = await lookup(
      context,
      facebookRequests.recentPosts(pageId, { accessToken }),
      accessToken,
      FacebookFeedSchema,
      "the Page's posts",
    );
    return feed === null ? null : findSentPost(feed, sent, context.post.attemptStartedAt);
  }

  /** The Page's latest stories; null when they cannot be read. */
  async function readStories(
    context: PublishContext,
    pageId: string,
    accessToken: string,
  ): Promise<FacebookStories | null> {
    return lookup(
      context,
      facebookRequests.stories(pageId, { accessToken }),
      accessToken,
      FacebookStoriesSchema,
      "the Page's stories",
    );
  }

  /**
   * The permalink of a published post. Read after the post is live, so a failure (even an
   * abort) never loses the post: the link falls back to `/<post-id>`.
   */
  async function postPermalink(
    context: PublishContext,
    postId: string,
    accessToken: string,
  ): Promise<string> {
    const read = await lookup(
      context,
      facebookRequests.permalink(postId, { accessToken }),
      accessToken,
      PermalinkFieldSchema,
      "the post's permalink",
    );
    return facebookPostPermalink(postId, read?.permalink_url);
  }

  /** The permalink of a published story: its `url` among the Page's stories, else `/<post-id>`. */
  async function storyPermalink(
    context: PublishContext,
    pageId: string,
    postId: string,
    accessToken: string,
  ): Promise<string> {
    const stories = await readStories(context, pageId, accessToken);
    const story: FacebookStory | null = stories === null ? null : storyByPostId(stories, postId);
    return facebookPostPermalink(postId, story?.url);
  }

  async function publishReel(
    context: PublishContext,
    request: VideoPublishRequest,
    accessToken: string,
  ): Promise<PublishResult> {
    const start = facebookRequests.startUpload(request.externalId, { accessToken });
    const started = await call(context, start, accessToken, StartSchema, "the upload start");
    const videoId = started.video_id;
    context.record({ response: { video_id: videoId } });

    const upload = facebookRequests.uploadFromUrl(videoId, request.videoUrl, { accessToken });
    await metaCall(context, options, upload.step, () => rupload.send(upload, context.signal));
    context.record({ response: { video_id: videoId, upload: "complete" } });

    const finish = facebookRequests.finishUpload(request, videoId, { accessToken });
    try {
      const finished = await call(context, finish, accessToken, SuccessSchema, "the upload finish");
      if (finished.success !== true) {
        throw PublishFailure.of("transient", "The platform did not confirm the Reel.");
      }
    } catch (error) {
      // A finish lost in transit may still have published the Reel: check before a retry
      // uploads it a second time.
      if (lostInTransit(context, error) && (await finishedAnyway(context, videoId, accessToken))) {
        context.logger.warn({ videoId }, "the Reel finish failed in transit but took effect");
      } else {
        throw error;
      }
    }
    context.record({ response: { video_id: videoId, upload: "complete", finish: "accepted" } });
    return { pending: true, containerId: videoId, externalId: videoId };
  }

  async function publishVideo(
    context: PublishContext,
    request: VideoPublishRequest,
    accessToken: string,
  ): Promise<PublishResult> {
    const upload = facebookRequests.uploadVideo(request, { accessToken });
    let videoId: string;
    try {
      videoId = (await call(context, upload, accessToken, IdSchema, "the video upload")).id;
    } catch (error) {
      // The Page's videos cannot be read back, so a lost upload is not retried.
      throw lostInTransit(context, error) ? unconfirmed(error, "The video upload") : error;
    }
    context.record({ response: { video_id: videoId, upload: "accepted" } });
    return { pending: true, containerId: videoId, externalId: videoId };
  }

  async function publishPhoto(
    context: PublishContext,
    request: MediaPublishRequest,
    accessToken: string,
  ): Promise<PublishResult> {
    const [item] = request.media;
    if (item === undefined) {
      throw PublishFailure.of("invalid_media", "A photo post carries one photo.", {
        retryable: false,
      });
    }
    const message = facebookMessage(request);
    const upload = facebookRequests.uploadPhoto(
      request.externalId,
      item,
      { caption: message, published: true },
      { accessToken },
    );
    let photo: z.output<typeof PhotoSchema>;
    try {
      photo = await call(context, upload, accessToken, PhotoSchema, "the photo upload");
    } catch (error) {
      if (!lostInTransit(context, error)) {
        throw error;
      }
      if (message === "") {
        throw unconfirmed(error, "The photo upload");
      }
      const found = await postedAnyway(context, request.externalId, { message }, accessToken);
      if (found === null) {
        throw error;
      }
      context.logger.warn({ postId: found.id }, "the photo post failed in transit but took effect");
      context.record({ response: { post_id: found.id, recovered: true } });
      return {
        pending: false,
        externalId: found.id,
        permalink: facebookPostPermalink(found.id, found.permalink_url),
      };
    }
    const postId = photo.post_id ?? photo.id;
    context.record({ response: { photo_id: photo.id, post_id: postId } });
    return {
      pending: false,
      containerId: photo.id,
      externalId: postId,
      permalink: await postPermalink(context, postId, accessToken),
    };
  }

  /** Publishes a feed post (text, link or multi-photo) and reads its permalink. */
  async function publishFeedPost(
    context: PublishContext,
    request: TextPublishRequest | MediaPublishRequest,
    photoIds: readonly string[],
    accessToken: string,
  ): Promise<PublishResult> {
    const message = facebookMessage(request);
    const create = facebookRequests.createPost(request, photoIds, { accessToken });
    let postId: string;
    try {
      postId = (await call(context, create, accessToken, IdSchema, "the post")).id;
    } catch (error) {
      if (!lostInTransit(context, error)) {
        throw error;
      }
      if (message === "" && photoIds.length === 0) {
        throw unconfirmed(error, "The post");
      }
      const found = await postedAnyway(
        context,
        request.externalId,
        { message, photoIds },
        accessToken,
      );
      if (found === null) {
        throw error;
      }
      context.logger.warn({ postId: found.id }, "the feed post failed in transit but took effect");
      context.record({
        response: {
          ...(photoIds.length === 0 ? {} : { photo_ids: [...photoIds] }),
          post_id: found.id,
          recovered: true,
        },
      });
      return {
        pending: false,
        externalId: found.id,
        permalink: facebookPostPermalink(found.id, found.permalink_url),
      };
    }
    context.record({
      response: { ...(photoIds.length === 0 ? {} : { photo_ids: [...photoIds] }), post_id: postId },
    });
    return {
      pending: false,
      externalId: postId,
      permalink: await postPermalink(context, postId, accessToken),
    };
  }

  async function publishCarousel(
    context: PublishContext,
    request: MediaPublishRequest,
    accessToken: string,
  ): Promise<PublishResult> {
    const photoIds: string[] = [];
    // Unpublished photos: a failure here leaves nothing on the Page, and a retry uploads them
    // again.
    for (const item of request.media) {
      const upload = facebookRequests.uploadPhoto(
        request.externalId,
        item,
        { published: false },
        { accessToken },
      );
      const photo = await call(context, upload, accessToken, PhotoSchema, "the photo upload");
      photoIds.push(photo.id);
      context.record({ response: { photo_ids: [...photoIds] } });
    }
    return publishFeedPost(context, request, photoIds, accessToken);
  }

  async function publishPhotoStory(
    context: PublishContext,
    request: MediaPublishRequest,
    accessToken: string,
  ): Promise<PublishResult> {
    const [item] = request.media;
    if (item === undefined) {
      throw PublishFailure.of("invalid_media", "A story carries one photo or video.", {
        retryable: false,
      });
    }
    const pageId = request.externalId;
    const upload = facebookRequests.uploadPhoto(
      pageId,
      item,
      { published: false },
      { accessToken },
    );
    const photo = await call(context, upload, accessToken, PhotoSchema, "the photo upload");
    context.record({ response: { photo_id: photo.id } });

    const publish = facebookRequests.photoStory(pageId, photo.id, { accessToken });
    let postId: string;
    try {
      const story = await call(context, publish, accessToken, StoryPostSchema, "the story");
      if (story.success !== true || story.post_id === undefined) {
        throw PublishFailure.of("transient", "The platform did not confirm the story.");
      }
      postId = story.post_id;
    } catch (error) {
      if (!lostInTransit(context, error)) {
        throw error;
      }
      const stories = await readStories(context, pageId, accessToken);
      const found =
        stories === null ? null : findSentPhotoStory(stories, context.post.attemptStartedAt);
      if (found?.post_id === undefined) {
        throw error;
      }
      context.logger.warn({ postId: found.post_id }, "the story failed in transit but took effect");
      context.record({ response: { photo_id: photo.id, post_id: found.post_id, recovered: true } });
      return {
        pending: false,
        containerId: photo.id,
        externalId: found.post_id,
        permalink: facebookPostPermalink(found.post_id, found.url),
      };
    }
    context.record({ response: { photo_id: photo.id, post_id: postId } });
    return {
      pending: false,
      containerId: photo.id,
      externalId: postId,
      permalink: await storyPermalink(context, pageId, postId, accessToken),
    };
  }

  async function publishVideoStory(
    context: PublishContext,
    request: MediaPublishRequest,
    accessToken: string,
  ): Promise<PublishResult> {
    const [item] = request.media;
    if (item === undefined) {
      throw PublishFailure.of("invalid_media", "A story carries one photo or video.", {
        retryable: false,
      });
    }
    const pageId = request.externalId;
    const start = facebookRequests.startUpload(pageId, { accessToken }, "video_stories");
    const started = await call(context, start, accessToken, StartSchema, "the upload start");
    const videoId = started.video_id;
    context.record({ response: { video_id: videoId } });

    const upload = facebookRequests.uploadFromUrl(videoId, item.url, { accessToken });
    await metaCall(context, options, upload.step, () => rupload.send(upload, context.signal));
    context.record({ response: { video_id: videoId, upload: "complete" } });

    const finish = facebookRequests.finishStoryUpload(pageId, videoId, { accessToken });
    let postId: string | undefined;
    try {
      const finished = await call(
        context,
        finish,
        accessToken,
        StoryPostSchema,
        "the upload finish",
      );
      if (finished.success !== true) {
        throw PublishFailure.of("transient", "The platform did not confirm the story.");
      }
      postId = finished.post_id;
    } catch (error) {
      // As for a Reel: a finish lost in transit may still have published the story.
      if (lostInTransit(context, error) && (await finishedAnyway(context, videoId, accessToken))) {
        context.logger.warn({ videoId }, "the story finish failed in transit but took effect");
      } else {
        throw error;
      }
    }
    context.record({
      response: {
        video_id: videoId,
        upload: "complete",
        finish: "accepted",
        ...(postId === undefined ? {} : { post_id: postId }),
      },
    });
    return { pending: true, containerId: videoId, externalId: postId ?? videoId };
  }

  return {
    platform: "facebook",

    async validate(context): Promise<AdapterIssue[]> {
      const request = await context.publishRequest();
      return [
        ...validateFacebookRequest(request, videoFacts(context.media)),
        ...context.caption().issues.map((issue) => ({ field: "caption", message: issue.message })),
      ];
    },

    async publish(context): Promise<PublishResult> {
      requireApp();
      const { accessToken } = await credentialsOf(context, options);
      const request = await context.publishRequest();
      if (isVideoRequest(request)) {
        // Throws `invalid_media` for a video post without a video.
        videoOf(context.media);
      }
      const plan = buildFacebookPublish({
        request,
        media: videoFacts(context.media),
        accessToken,
      });
      context.record({ request: plan as unknown as JsonObject });

      switch (request.format) {
        case "reel":
          return publishReel(context, request, accessToken);
        case "video":
          return publishVideo(context, request, accessToken);
        case "image":
          return publishPhoto(context, request, accessToken);
        case "carousel":
          return publishCarousel(context, request, accessToken);
        case "story":
          return request.media[0]?.type === "video"
            ? publishVideoStory(context, request, accessToken)
            : publishPhotoStory(context, request, accessToken);
        case "text":
          return publishFeedPost(context, request, [], accessToken);
      }
    },

    async status(context): Promise<StatusResult> {
      requireApp();
      const kind = videoKindOf(context.media);
      if (kind === null) {
        // Photo, multi-photo and text posts and photo stories are published by `publish`.
        const postId = context.post.externalId;
        if (postId === null) {
          throw PublishFailure.of("permanent", "The post has no published id to check.", {
            retryable: false,
          });
        }
        return {
          state: "published",
          externalId: postId,
          permalink: facebookPostPermalink(postId, undefined),
        };
      }
      const videoId = context.post.externalContainerId ?? context.post.externalId;
      if (videoId === null) {
        throw PublishFailure.of("permanent", "The post has no uploaded video to check.", {
          retryable: false,
        });
      }
      const { accessToken } = await credentialsOf(context, options);
      const video = await readVideo(
        context,
        facebookRequests.videoStatus(videoId, { accessToken }),
        accessToken,
      );
      let result = facebookStatusOf(videoId, video, kind);
      if (result.state === "published" && kind === "story") {
        const postId = context.post.externalId ?? videoId;
        const pageId = context.channel.externalId;
        result = {
          state: "published",
          permalink:
            pageId === null
              ? facebookPostPermalink(postId, undefined)
              : await storyPermalink(context, pageId, postId, accessToken),
        };
      }
      context.record({
        response: {
          video_id: videoId,
          state: result.state,
          ...(video.status === undefined ? {} : { status: video.status as JsonObject }),
          ...(result.permalink === undefined ? {} : { permalink: result.permalink }),
        },
      });
      return result;
    },
  };
}
