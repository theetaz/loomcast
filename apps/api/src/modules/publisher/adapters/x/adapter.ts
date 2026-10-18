import type { JsonObject, PublishError, VideoPublishRequest } from "@loomcast/contracts";
import { z } from "zod";
import { HttpError } from "../../../../lib/errors";
import type { FetchLike } from "../../../../lib/meta-graph";
import { VaultError } from "../../../../lib/vault";
import { xWeightedLength } from "../../caption";
import { PublishFailure, publishError } from "../../errors";
import { videoFacts, videoOf } from "../../media";
import { REDACTED, redactRequest } from "../../redact";
import { buildXPublish, validateXRequest, xRequests } from "../../requests/x";
import type {
  AdapterIssue,
  PublishContext,
  PublisherAdapter,
  PublishResult,
  StatusResult,
} from "../../types";
import { XApiError, type XClient, type XRateLimit } from "./client";
import { usableXApp, type XPlatforms, xClientFor } from "./config";
import { freshXAccessToken, saveXRateLimit, type XTokenStore } from "./tokens";
import {
  toXRequest,
  uploadXVideo,
  type XMediaSource,
  type XProcessingInfo,
  xUploadStatus,
} from "./upload";

// The live X adapter. `publish` uploads the render with the v2 chunked upload (see `upload.ts`)
// and, when X has nothing left to process, posts it at once (`POST /2/tweets {text, media:
// {media_ids}}`); otherwise the post is pending on the media id and `status` polls the upload
// until it succeeds, then posts. The permalink is `https://x.com/<username>/status/<id>`.
//
// Behind `FEATURE_X_PUBLISHING`: while the flag is off (or the X app is not configured) every
// method refuses with a permanent `not_configured` before it reads credentials, touches storage
// or builds a client call, so nothing ever reaches X.

/** Most characters (weighted) X takes in a post. */
export const X_POST_MAX_WEIGHTED_LENGTH = 280;

export interface XAdapterOptions {
  platforms: XPlatforms;
  /** Where the channel's token pair is read and the rotated pair written. Required to publish. */
  tokens?: XTokenStore;
  /** The render's bytes. Required to publish. */
  media?: XMediaSource;
  /** Overrides the global `fetch` (tests). */
  fetch?: FetchLike;
  /** Waits between retries of safe calls; tests pass one that returns at once. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Called when X refuses the channel's credentials, so the channel can be flagged for reauth. */
  onCredentialsRefused?: (input: {
    channelId: string;
    error: PublishError;
    reason: string;
  }) => Promise<void>;
}

const CreatedPostSchema = z.object({ data: z.object({ id: z.string().regex(/^\d{1,20}$/) }) });

/** The permalink of post `id` by `username`; the handle-free form when the handle is unknown. */
export function xPermalink(username: string | null, id: string): string {
  const handle = username?.replace(/^@/, "").trim() ?? "";
  return /^\w{1,15}$/.test(handle)
    ? `https://x.com/${handle}/status/${id}`
    : `https://x.com/i/web/status/${id}`;
}

function notConfigured(): PublishFailure {
  return PublishFailure.of(
    "not_configured",
    "X publishing is turned off on this server (FEATURE_X_PUBLISHING).",
    { retryable: false },
  );
}

/** The rate-limit snapshot kept on the channel and in the attempt's record. */
function rateSnapshot(step: string, rate: XRateLimit, at: Date): JsonObject {
  return {
    platform: "x",
    step,
    limit: rate.limit,
    remaining: rate.remaining,
    resetAt: rate.resetAt,
    userDayLimit: rate.userDayLimit,
    userDayRemaining: rate.userDayRemaining,
    userDayResetAt: rate.userDayResetAt,
    capturedAt: at.toISOString(),
  };
}

/**
 * The request facts X needs. X uploads bytes instead of fetching a URL, so the render is not
 * copied to the public bucket: `videoUrl` names the stored asset and is never sent.
 */
function xPublishRequest(context: PublishContext): VideoPublishRequest {
  const { channel } = context;
  const media = videoOf(context.media);
  if (media.durationMs === null || media.durationMs < 1) {
    throw PublishFailure.of("invalid_media", "The render has no duration.", { retryable: false });
  }
  return {
    platform: "x",
    format: "reel",
    externalId: channel.externalId ?? "",
    videoUrl: `https://storage.invalid/assets/${media.assetId}`,
    caption: context.caption().text,
    durationMs: media.durationMs,
    width: media.width ?? 1_080,
    height: media.height ?? 1_920,
  };
}

/** The live X adapter with `options`. */
export function createXAdapter(options: XAdapterOptions): PublisherAdapter {
  let client: XClient | null = null;
  const clientOf = (): XClient => {
    client ??= xClientFor(options.platforms, {
      fetch: options.fetch,
      ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    });
    return client;
  };

  /** The X app, or a `not_configured` refusal while the flag is off. */
  function requireEnabled() {
    const app = usableXApp(options.platforms);
    if (app === null) {
      throw notConfigured();
    }
    return app;
  }

  function requireLive(context: PublishContext) {
    const app = requireEnabled();
    if (context.dryRun) {
      throw new Error("the live X adapter never handles a dry-run post");
    }
    if (options.tokens === undefined || options.media === undefined) {
      throw PublishFailure.of("not_configured", "The X adapter is not wired to storage.", {
        retryable: false,
      });
    }
    if (context.channel.externalId === null) {
      throw PublishFailure.of("not_configured", "The channel has no X account.", {
        retryable: false,
      });
    }
    return { app, tokens: options.tokens, media: options.media };
  }

  /** Turns platform errors into publish failures, flagging refused credentials. */
  async function guard<T>(
    context: PublishContext,
    step: string,
    run: () => Promise<T>,
  ): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (context.signal.aborted || error instanceof PublishFailure) {
        throw error;
      }
      if (error instanceof XApiError) {
        context.logger.warn({ step, failure: error.toLog() }, "an X API call failed");
        if (error.rateLimit !== null && options.tokens !== undefined) {
          await saveXRateLimit(
            options.tokens,
            context.channel.id,
            rateSnapshot(step, error.rateLimit, context.now()),
          ).catch(() => undefined);
        }
        if (
          (error.error.code === "auth" || error.error.code === "permission") &&
          options.onCredentialsRefused !== undefined
        ) {
          await options.onCredentialsRefused({
            channelId: context.channel.id,
            error: error.error,
            reason: step === "refresh_token" ? "refresh_refused" : "publish_refused",
          });
        }
        throw new PublishFailure(error.error);
      }
      if (error instanceof VaultError) {
        throw PublishFailure.of(
          "auth",
          "The channel's stored credentials cannot be read; reconnect it.",
          {
            retryable: false,
          },
        );
      }
      if (error instanceof HttpError) {
        throw PublishFailure.of("not_configured", "Credential encryption is not configured.", {
          retryable: false,
        });
      }
      throw error;
    }
  }

  async function accessToken(context: PublishContext): Promise<string> {
    const { app, tokens } = requireLive(context);
    const fresh = await guard(context, "refresh_token", () =>
      freshXAccessToken(tokens, {
        client: clientOf(),
        app,
        channelId: context.channel.id,
        now: context.now(),
        signal: context.signal,
      }),
    );
    if (fresh.refreshed) {
      context.logger.info({ channelId: context.channel.id }, "the X token pair was rotated");
    }
    return fresh.accessToken;
  }

  async function createPost(
    context: PublishContext,
    token: string,
    mediaId: string,
  ): Promise<{ externalId: string; permalink: string }> {
    const request = xPublishRequest(context);
    const step = xRequests.createPost(request, mediaId, { accessToken: token });
    const response = await guard(context, "create_post", () =>
      clientOf().request(toXRequest(step, token, context.signal)),
    );
    const parsed = CreatedPostSchema.safeParse(response.data);
    if (!parsed.success) {
      // The post may exist; retrying could post it twice.
      throw PublishFailure.of("permanent", "X answered the post in an unexpected form.", {
        retryable: false,
      });
    }
    const externalId = parsed.data.data.id;
    const permalink = xPermalink(context.channel.username, externalId);
    context.record({
      response: {
        mediaId,
        postId: externalId,
        permalink,
        ...(response.rateLimit === null
          ? {}
          : { rateLimit: rateSnapshot("create_post", response.rateLimit, context.now()) }),
      },
    });
    if (response.rateLimit !== null && options.tokens !== undefined) {
      await saveXRateLimit(
        options.tokens,
        context.channel.id,
        rateSnapshot("create_post", response.rateLimit, context.now()),
      ).catch(() => undefined);
    }
    return { externalId, permalink };
  }

  function processingFailed(info: XProcessingInfo): PublishError {
    const detail = info.error?.message?.slice(0, 200);
    return publishError(
      "invalid_media",
      detail === undefined
        ? "X could not process the video."
        : `X could not process the video: ${detail}`,
      {
        retryable: false,
        ...(info.error?.code === undefined ? {} : { platformCode: String(info.error.code) }),
      },
    );
  }

  return {
    platform: "x",

    async validate(context): Promise<AdapterIssue[]> {
      requireEnabled();
      const request = xPublishRequest(context);
      const issues: AdapterIssue[] = [
        ...validateXRequest(request, videoFacts(context.media)),
        ...context.caption().issues.map((issue) => ({ field: "caption", message: issue.message })),
      ];
      if (xWeightedLength(request.caption) > X_POST_MAX_WEIGHTED_LENGTH) {
        issues.push({
          field: "caption",
          message: `The text is longer than ${X_POST_MAX_WEIGHTED_LENGTH} weighted characters.`,
        });
      }
      return issues;
    },

    async publish(context): Promise<PublishResult> {
      const { media } = requireLive(context);
      const request = xPublishRequest(context);
      const video = videoOf(context.media);
      const facts = { bytes: video.bytes, mime: video.mime };
      // The same record a dry run makes, before anything is sent.
      context.record({
        request: redactRequest(
          buildXPublish({ request, media: facts, accessToken: REDACTED }) as unknown as JsonObject,
        ),
      });
      const token = await accessToken(context);
      const uploaded = await guard(context, "upload", () =>
        uploadXVideo({
          client: clientOf(),
          accessToken: token,
          media: facts,
          open: () => media(video, context.signal),
          signal: context.signal,
        }),
      );
      const state = uploaded.processing?.state ?? "succeeded";
      if (state === "failed" && uploaded.processing !== null) {
        throw new PublishFailure(processingFailed(uploaded.processing));
      }
      if (state !== "succeeded") {
        context.record({ response: { mediaId: uploaded.mediaId, processing: state } });
        return { pending: true, containerId: uploaded.mediaId };
      }
      const posted = await createPost(context, token, uploaded.mediaId);
      return { pending: false, externalId: posted.externalId, permalink: posted.permalink };
    },

    async status(context): Promise<StatusResult> {
      requireLive(context);
      const mediaId = context.post.externalContainerId;
      if (context.post.externalId !== null) {
        return {
          state: "published",
          externalId: context.post.externalId,
          permalink: xPermalink(context.channel.username, context.post.externalId),
        };
      }
      if (mediaId === null) {
        throw PublishFailure.of("permanent", "The X upload id was not recorded.", {
          retryable: false,
        });
      }
      const token = await accessToken(context);
      const { processing } = await guard(context, "upload_status", () =>
        xUploadStatus({ client: clientOf(), accessToken: token, mediaId, signal: context.signal }),
      );
      const state = processing?.state ?? "succeeded";
      if (state === "failed" && processing !== null) {
        return { state: "failed", error: processingFailed(processing) };
      }
      if (state !== "succeeded") {
        return { state: "pending" };
      }
      const posted = await createPost(context, token, mediaId);
      return { state: "published", externalId: posted.externalId, permalink: posted.permalink };
    },
  };
}
