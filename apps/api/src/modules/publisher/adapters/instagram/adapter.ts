import type { JsonObject } from "@loomcast/contracts";
import { z } from "zod";
import type { GraphClient } from "../../../../lib/meta-graph";
import { PublishFailure, publishError } from "../../errors";
import { videoFacts } from "../../media";
import { buildInstagramFinish, buildInstagramPublish, instagramRequests } from "../../requests";
import type {
  AdapterIssue,
  PublishContext,
  PublisherAdapter,
  PublishResult,
  StatusResult,
} from "../../types";
import {
  asPublishFailure,
  type GraphClientSource,
  graphClientFromEnv,
  isNotReadyError,
  lazyGraphClient,
  sendStep,
} from "./graph";
import { recentMediaRequest } from "./media";
import { checkQuota, quotaRecord } from "./quota";
import { validateInstagramReel } from "./validate";

// The live Instagram Reels adapter (Instagram API with Facebook Login, Graph API v26.0):
// - `publish` checks the account's 24-hour quota, copies the render to public storage and
//   creates a Reels container from its URL (`POST /{ig-user-id}/media`, `media_type=REELS`,
//   `share_to_feed=true`), then reports the post pending with the container id;
// - `status` reads the container (`GET /{container-id}?fields=status_code,status`): IN_PROGRESS
//   stays pending; FINISHED is published once (`POST /{ig-user-id}/media_publish`) and its
//   permalink read (`GET /{media-id}?fields=permalink`); ERROR and EXPIRED fail as
//   `invalid_media` with Meta's status text; PUBLISHED returns the media already published.
// Every request is built by `requests/instagram.ts`, so it matches what a dry run records.

/** Containers whose `media_publish` this process sent, and the media id it returned. */
const MAX_REMEMBERED_PUBLISHES = 500;

const ContainerSchema = z.object({
  id: z.string().optional(),
  status_code: z.string().optional(),
  status: z.string().optional(),
});

const IdSchema = z.object({ id: z.coerce.string().min(1) });
const PermalinkSchema = z.object({ permalink: z.string().optional() });

export interface InstagramAdapterOptions {
  /** The Graph client; defaults to the server's Meta app from the environment, built on first use. */
  client?: GraphClientSource;
  /** How long a post waits when the quota is used up; defaults to `INSTAGRAM_QUOTA_RETRY_MS`. */
  quotaRetryMs?: number;
}

/** What the adapter needs for a live call: the client, the token and the account id. */
interface LiveCall {
  client: GraphClient;
  accessToken: string;
  igUserId: string;
  signal: AbortSignal;
}

/** The text of a container's `status`, without URLs; its 2207xxx subcode as the platform code. */
function containerFailure(code: string, status: string | undefined): StatusResult {
  const text = (status ?? "").replace(/https?:\/\/\S+/gi, "[url]").trim();
  const subcode = /\b(2207\d{3})\b/.exec(text)?.[1];
  const message =
    code === "EXPIRED"
      ? `The Instagram container expired before it was published${text === "" ? "." : `: ${text}`}`
      : `Instagram could not process the video${text === "" ? "." : `: ${text}`}`;
  return {
    state: "failed",
    error: publishError("invalid_media", message, {
      retryable: false,
      platformCode: subcode ?? code,
    }),
  };
}

export function createInstagramAdapter(options: InstagramAdapterOptions = {}): PublisherAdapter {
  const client = lazyGraphClient(options.client ?? (() => graphClientFromEnv()));
  /** `media_publish` per container: in flight or done, so a container is never published twice. */
  const publishes = new Map<string, Promise<string>>();

  async function liveCall(context: PublishContext): Promise<LiveCall> {
    if (context.dryRun) {
      throw new Error("the live Instagram adapter never handles dry-run posts");
    }
    const graph = client();
    const igUserId = context.channel.externalId;
    if (igUserId === null) {
      throw PublishFailure.of("not_configured", "The channel has no Instagram account.", {
        retryable: false,
      });
    }
    const { accessToken } = await context.secrets();
    return { client: graph, accessToken, igUserId, signal: context.signal };
  }

  async function permalinkOf(call: LiveCall, mediaId: string): Promise<string | undefined> {
    const response = await sendStep<unknown>(
      call.client,
      instagramRequests.permalink(mediaId, call),
      call,
    );
    const parsed = PermalinkSchema.safeParse(response.data);
    return parsed.success ? parsed.data.permalink : undefined;
  }

  /**
   * The media of a container that is already PUBLISHED but whose media id this process does not
   * know (the server restarted after `media_publish`, or the call timed out after Meta took it).
   * The container does not name its media, so the account's recent Reels are matched by caption
   * and time. Null when none matches.
   */
  async function findPublished(
    call: LiveCall,
    context: PublishContext,
  ): Promise<{ id: string; permalink?: string } | null> {
    const response = await sendStep<unknown>(
      call.client,
      recentMediaRequest(call.igUserId, call),
      call,
    );
    const caption = context.caption().text.trim();
    // A container lives 24 hours, so its media cannot be older than that before this attempt.
    const since = context.post.attemptStartedAt.getTime() - 25 * 60 * 60_000;
    const items = z.object({ data: z.array(z.unknown()).default([]) }).safeParse(response.data);
    for (const entry of items.success ? items.data.data : []) {
      const media = z
        .object({
          id: z.coerce.string(),
          permalink: z.string().optional(),
          caption: z.string().optional(),
          timestamp: z.string().optional(),
          media_product_type: z.string().optional(),
        })
        .safeParse(entry);
      if (!media.success) {
        continue;
      }
      const { id, permalink, timestamp, media_product_type: product } = media.data;
      const at = timestamp === undefined ? Number.NaN : Date.parse(timestamp);
      if (
        (product === undefined || product === "REELS") &&
        (media.data.caption ?? "").trim() === caption &&
        (Number.isNaN(at) || at >= since)
      ) {
        return permalink === undefined ? { id } : { id, permalink };
      }
    }
    return null;
  }

  /** The result of a container that is already PUBLISHED. */
  async function alreadyPublished(
    call: LiveCall,
    context: PublishContext,
    containerId: string,
  ): Promise<StatusResult> {
    const known = context.post.externalId ?? (await rememberedPublish(containerId));
    if (known !== null) {
      const permalink = await permalinkOf(call, known);
      context.record({
        response: {
          container_id: containerId,
          status_code: "PUBLISHED",
          media_id: known,
          permalink: permalink ?? null,
        },
      });
      return {
        state: "published",
        externalId: known,
        ...(permalink === undefined ? {} : { permalink }),
      };
    }
    const found = await findPublished(call, context);
    context.record({
      response: {
        container_id: containerId,
        status_code: "PUBLISHED",
        media_id: found?.id ?? null,
        permalink: found?.permalink ?? null,
      },
    });
    if (found === null) {
      context.logger.warn(
        { containerId },
        "the Instagram container is published, but its media was not found",
      );
      return { state: "published" };
    }
    return {
      state: "published",
      externalId: found.id,
      ...(found.permalink === undefined ? {} : { permalink: found.permalink }),
    };
  }

  /** The media id of a `media_publish` this process already sent for `containerId`, if any. */
  async function rememberedPublish(containerId: string): Promise<string | null> {
    const pending = publishes.get(containerId);
    if (pending === undefined) {
      return null;
    }
    try {
      return await pending;
    } catch {
      return null;
    }
  }

  /**
   * Sends `media_publish` for `containerId` at most once per process: a concurrent or repeated
   * call waits for (or reuses) the first one. A failed call is forgotten, so it may be retried.
   */
  function publishOnce(call: LiveCall, containerId: string): Promise<string> {
    const existing = publishes.get(containerId);
    if (existing !== undefined) {
      return existing;
    }
    const [, publishStep] = buildInstagramFinish(call.igUserId, containerId, call);
    if (publishStep === undefined) {
      throw new Error("the Instagram finish plan has no media_publish step");
    }
    const sent = sendStep<unknown>(call.client, publishStep, { ...call, raw: true }).then(
      (response) => IdSchema.parse(response.data).id,
    );
    publishes.set(containerId, sent);
    sent.catch(() => {
      if (publishes.get(containerId) === sent) {
        publishes.delete(containerId);
      }
    });
    if (publishes.size > MAX_REMEMBERED_PUBLISHES) {
      const oldest = publishes.keys().next().value;
      if (oldest !== undefined && oldest !== containerId) {
        publishes.delete(oldest);
      }
    }
    return sent;
  }

  /** Reads the container's status. */
  async function containerStatus(call: LiveCall, containerId: string) {
    const [statusStep] = buildInstagramFinish(call.igUserId, containerId, call);
    if (statusStep === undefined) {
      throw new Error("the Instagram finish plan has no status step");
    }
    const response = await sendStep<unknown>(call.client, statusStep, call);
    const parsed = ContainerSchema.safeParse(response.data);
    return parsed.success ? parsed.data : {};
  }

  return {
    platform: "instagram",

    async validate(context): Promise<AdapterIssue[]> {
      return validateInstagramReel(context);
    },

    async publish(context): Promise<PublishResult> {
      const call = await liveCall(context);

      // A post whose earlier container was published (the outcome was lost) is not posted again.
      if (context.post.externalId !== null || context.post.externalContainerId !== null) {
        const previous = context.post.externalContainerId;
        const code =
          previous === null
            ? "PUBLISHED"
            : await containerStatus(call, previous).then(
                (status) => status.status_code,
                () => undefined,
              );
        if (code === "PUBLISHED") {
          const result = await alreadyPublished(call, context, previous ?? "");
          return {
            pending: false,
            ...(result.externalId === undefined ? {} : { externalId: result.externalId }),
            ...(result.permalink === undefined ? {} : { permalink: result.permalink }),
            ...(previous === null ? {} : { containerId: previous }),
          };
        }
      }

      // The quota is checked before the render is copied to public storage: every copy is new,
      // so a post waiting out the quota would otherwise leave a public copy per attempt.
      const limitStep = instagramRequests.publishingLimit(call.igUserId, call);
      context.record({
        request: { platform: "instagram", pending: true, steps: [limitStep] } as JsonObject,
      });
      const quota = await checkQuota(call.client, limitStep, {
        ...call,
        ...(options.quotaRetryMs === undefined ? {} : { retryMs: options.quotaRetryMs }),
      }).catch((error: unknown) => {
        if (error instanceof PublishFailure && error.error.code === "rate_limited") {
          context.record({ response: { step: "publishing_limit", error: error.error.message } });
        }
        throw error;
      });

      const request = await context.publishRequest();
      const plan = buildInstagramPublish({
        request,
        media: videoFacts(context.media),
        accessToken: call.accessToken,
      });
      context.record({ request: plan as unknown as JsonObject });
      const createStep = plan.steps[1];
      if (createStep === undefined) {
        throw new Error("the Instagram publish plan has no create_container step");
      }
      const created = await sendStep<unknown>(call.client, createStep, call);
      const container = IdSchema.safeParse(created.data);
      if (!container.success) {
        throw PublishFailure.of(
          "transient",
          "Instagram created the container without returning its id.",
        );
      }
      context.record({
        response: { ...quotaRecord(quota), container_id: container.data.id },
      });
      return { pending: true, containerId: container.data.id };
    },

    async status(context): Promise<StatusResult> {
      const call = await liveCall(context);
      const containerId = context.post.externalContainerId;
      if (containerId === null) {
        if (context.post.externalId !== null) {
          return alreadyPublished(call, context, "");
        }
        throw PublishFailure.of("permanent", "The post has no Instagram container to check.", {
          retryable: false,
        });
      }

      const container = await containerStatus(call, containerId);
      const code = container.status_code;
      switch (code) {
        case "IN_PROGRESS":
          context.record({ response: { container_id: containerId, status_code: code } });
          return { state: "pending" };
        case "ERROR":
        case "EXPIRED":
          context.record({
            response: {
              container_id: containerId,
              status_code: code,
              status: container.status ?? null,
            },
          });
          return containerFailure(code, container.status);
        case "PUBLISHED":
          return alreadyPublished(call, context, containerId);
        case "FINISHED": {
          let mediaId: string;
          try {
            mediaId = await publishOnce(call, containerId);
          } catch (error) {
            if (isNotReadyError(error)) {
              context.record({ response: { container_id: containerId, status_code: code } });
              return { state: "pending" };
            }
            if (error instanceof z.ZodError) {
              throw PublishFailure.of(
                "transient",
                "Instagram published the container without returning the media id.",
              );
            }
            throw asPublishFailure(error);
          }
          const permalink = await permalinkOf(call, mediaId);
          context.record({
            response: {
              container_id: containerId,
              status_code: code,
              media_id: mediaId,
              permalink: permalink ?? null,
            },
          });
          return {
            state: "published",
            externalId: mediaId,
            ...(permalink === undefined ? {} : { permalink }),
          };
        }
        default:
          context.logger.warn(
            { containerId, statusCode: code ?? null },
            "the Instagram container reported an unknown status; still waiting",
          );
          return { state: "pending" };
      }
    },
  };
}
