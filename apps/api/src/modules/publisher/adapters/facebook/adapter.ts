import type { JsonObject } from "@loomcast/contracts";
import { z } from "zod";
import { createMetaGraphClient, type GraphClient, parseGraph } from "../../../../lib/meta-graph";
import { PublishFailure } from "../../errors";
import {
  buildFacebookPublish,
  facebookRequests,
  validateFacebookRequest,
} from "../../requests/facebook";
import type { PlatformRequest } from "../../requests/types";
import type { AdapterIssue, PublishContext, PublisherAdapter, PublishResult } from "../../types";
import {
  clientOptions,
  credentialsOf,
  type MetaAdapterOptions,
  metaCall,
  stepOf,
  toGraphRequest,
} from "./meta-call";
import { createRuploadClient, RUPLOAD_BASE_URL } from "./rupload";
import {
  type FacebookVideo,
  FacebookVideoSchema,
  facebookStatusOf,
  finishTookEffect,
} from "./status";

// The live Facebook Page Reels adapter. `publish` sends what `buildFacebookPublish` builds:
// - `POST /{page-id}/video_reels {upload_phase: "start"}` → `{video_id, upload_url}`;
// - `POST rupload.facebook.com/video-upload/<version>/{video-id}` with `Authorization: OAuth`
//   and `file_url` (the public copy of the render), so the upload host fetches the video;
// - `POST /{page-id}/video_reels {upload_phase: "finish", video_id, video_state: "PUBLISHED",
//   description}`.
// The Reel then processes, so the post is pending; `status` reads
// `GET /{video-id}?fields=status,permalink_url` until the publishing phase completes.

const StartSchema = z.object({
  video_id: z.union([z.string().min(1), z.number()]).transform(String),
  upload_url: z.string().optional(),
});

const SuccessSchema = z.object({ success: z.boolean().optional() });

/** The live Facebook Page Reels adapter with `options`. */
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

  async function readVideo(
    context: PublishContext,
    step: PlatformRequest,
    accessToken: string,
  ): Promise<FacebookVideo> {
    return metaCall(context, options, step.step, async () =>
      parseGraph(
        FacebookVideoSchema,
        await graph.request(toGraphRequest(step, accessToken, context.signal)),
        "the video status",
      ),
    );
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

  return {
    platform: "facebook",

    async validate(context): Promise<AdapterIssue[]> {
      const request = await context.publishRequest();
      return [
        ...validateFacebookRequest(request, context.media),
        ...context.caption().issues.map((issue) => ({ field: "caption", message: issue.message })),
      ];
    },

    async publish(context): Promise<PublishResult> {
      requireApp();
      const { accessToken } = await credentialsOf(context, options);
      const request = await context.publishRequest();
      const plan = buildFacebookPublish({
        request,
        media: { bytes: context.media.bytes, mime: context.media.mime },
        accessToken,
      });
      context.record({ request: plan as unknown as JsonObject });

      const start = stepOf(plan.steps, "start_upload");
      const started = await metaCall(context, options, start.step, async () =>
        parseGraph(
          StartSchema,
          await graph.request(toGraphRequest(start, accessToken, context.signal)),
          "the upload start",
        ),
      );
      const videoId = started.video_id;
      context.record({ response: { video_id: videoId } });

      const upload = facebookRequests.uploadFromUrl(videoId, request.videoUrl, { accessToken });
      await metaCall(context, options, upload.step, () => rupload.send(upload, context.signal));
      context.record({ response: { video_id: videoId, upload: "complete" } });

      const finish = facebookRequests.finishUpload(request, videoId, { accessToken });
      try {
        const finished = await metaCall(context, options, finish.step, async () =>
          parseGraph(
            SuccessSchema,
            await graph.request(toGraphRequest(finish, accessToken, context.signal)),
            "the upload finish",
          ),
        );
        if (finished.success !== true) {
          throw PublishFailure.of("transient", "The platform did not confirm the Reel.");
        }
      } catch (error) {
        // A finish lost in transit may still have published the Reel: check before a retry
        // uploads it a second time.
        if (
          error instanceof PublishFailure &&
          error.error.code === "transient" &&
          !context.signal.aborted &&
          (await finishedAnyway(context, videoId, accessToken))
        ) {
          context.logger.warn({ videoId }, "the Reel finish failed in transit but took effect");
        } else {
          throw error;
        }
      }
      context.record({ response: { video_id: videoId, upload: "complete", finish: "accepted" } });
      return { pending: true, containerId: videoId, externalId: videoId };
    },

    async status(context) {
      requireApp();
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
      const result = facebookStatusOf(videoId, video);
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
