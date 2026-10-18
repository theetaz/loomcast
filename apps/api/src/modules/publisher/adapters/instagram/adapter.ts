import type { JsonObject, PostFormat } from "@loomcast/contracts";
import { z } from "zod";
import type { GraphClient } from "../../../../lib/meta-graph";
import { PublishFailure, publishError } from "../../errors";
import { videoFacts } from "../../media";
import {
  buildInstagramFinish,
  buildInstagramPublish,
  instagramRequests,
  type PlatformRequest,
} from "../../requests";
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
import { recentMediaRequest, recentStoriesRequest } from "./media";
import { checkQuota, quotaRecord } from "./quota";
import { validateInstagramPost } from "./validate";

// The live Instagram adapter (Instagram API with Facebook Login, Graph API v26.0) for Reels,
// photos, carousels and stories:
// - `publish` checks the account's 24-hour quota, copies the media to public storage and creates
//   the containers from their URLs (`POST /{ig-user-id}/media`): one for a Reel
//   (`media_type=REELS`), a photo (`image_url`) or a story (`media_type=STORIES`), then reports
//   the post pending with the container id. A carousel gets one container per item
//   (`is_carousel_item=true`); the post is pending with the staged id `items:<id>,<id>,...`
//   (`stagedCarouselId`) until the items are processed;
// - `status` reads the container (`GET /{container-id}?fields=status_code,status`): IN_PROGRESS
//   stays pending; FINISHED is published once (`POST /{ig-user-id}/media_publish`) and its
//   permalink read (`GET /{media-id}?fields=permalink`; a story may have none); ERROR and EXPIRED
//   fail as `invalid_media` with Meta's status text; PUBLISHED returns the media already
//   published. For a staged carousel it reads every item container instead and, once all are
//   FINISHED, creates the carousel container (`media_type=CAROUSEL`, `children`) and hands its
//   id back (`StatusResult.containerId`), so later polls follow the carousel container. A
//   carousel counts as one post against the quota.
// Every request is built by `requests/instagram.ts`, so it matches what a dry run records.

/** Containers whose `media_publish` this process sent, and the media id it returned. */
const MAX_REMEMBERED_PUBLISHES = 500;

/** Prefix of a post's container id while its carousel items process. */
const STAGED_PREFIX = "items:";

/** The container id a carousel post holds while its item containers process. */
export function stagedCarouselId(itemContainerIds: readonly string[]): string {
  return `${STAGED_PREFIX}${itemContainerIds.join(",")}`;
}

/** The item container ids of a staged carousel id; null for any other container id. */
export function stagedItemIds(containerId: string): string[] | null {
  if (!containerId.startsWith(STAGED_PREFIX)) {
    return null;
  }
  const ids = containerId
    .slice(STAGED_PREFIX.length)
    .split(",")
    .filter((id) => id !== "");
  return ids.length === 0 ? null : ids;
}

const ContainerSchema = z.object({
  id: z.string().optional(),
  status_code: z.string().optional(),
  status: z.string().optional(),
});
type Container = z.infer<typeof ContainerSchema>;

const IdSchema = z.object({ id: z.coerce.string().min(1) });
const PermalinkSchema = z.object({ permalink: z.string().optional() });

/** What `media_product_type` the published media of each format has. */
const PRODUCT_TYPES: Partial<Record<PostFormat, string>> = {
  reel: "REELS",
  image: "FEED",
  carousel: "FEED",
  story: "STORY",
};

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
function containerFailure(
  code: string,
  status: string | undefined,
  format: PostFormat,
  item?: number,
): StatusResult {
  const text = (status ?? "").replace(/https?:\/\/\S+/gi, "[url]").trim();
  const subcode = /\b(2207\d{3})\b/.exec(text)?.[1];
  const what =
    item !== undefined
      ? `item ${item + 1} of the carousel`
      : format === "reel"
        ? "the video"
        : format === "image"
          ? "the photo"
          : "the media";
  const message =
    code === "EXPIRED"
      ? `The Instagram container ${item === undefined ? "" : `of ${what} `}expired before it was published${text === "" ? "." : `: ${text}`}`
      : `Instagram could not process ${what}${text === "" ? "." : `: ${text}`}`;
  return {
    state: "failed",
    error: publishError("invalid_media", message, {
      retryable: false,
      platformCode: subcode ?? code,
    }),
  };
}

/** A container id from a create answer; a missing id is worth another try. */
function createdId(data: unknown, what: string): string {
  const parsed = IdSchema.safeParse(data);
  if (!parsed.success) {
    throw PublishFailure.of("transient", `Instagram created the ${what} without returning its id.`);
  }
  return parsed.data.id;
}

export function createInstagramAdapter(options: InstagramAdapterOptions = {}): PublisherAdapter {
  const client = lazyGraphClient(options.client ?? (() => graphClientFromEnv()));
  /** `media_publish` per container: in flight or done, so a container is never published twice. */
  const publishes = new Map<string, Promise<string>>();
  /** The carousel container per staged id, so concurrent polls create one. */
  const carousels = new Map<string, Promise<string>>();

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
   * The container does not name its media, so the account's recent media of the post's product
   * type are matched by caption and time: Reels and feed posts from `/media`, stories (which take
   * no caption) from `/stories`, where the one story since the attempt began matches. Null when
   * none matches, or when several stories could be the post.
   */
  async function findPublished(
    call: LiveCall,
    context: PublishContext,
  ): Promise<{ id: string; permalink?: string } | null> {
    const format = context.media.format;
    const story = format === "story";
    const product = PRODUCT_TYPES[format];
    const response = await sendStep<unknown>(
      call.client,
      story ? recentStoriesRequest(call.igUserId, call) : recentMediaRequest(call.igUserId, call),
      call,
    );
    const caption = context.caption().text.trim();
    // A container lives 24 hours, so its media cannot be older than that before this attempt.
    const since = context.post.attemptStartedAt.getTime() - 25 * 60 * 60_000;
    const items = z.object({ data: z.array(z.unknown()).default([]) }).safeParse(response.data);
    const matches: { id: string; permalink?: string }[] = [];
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
      const { id, permalink, timestamp, media_product_type: type } = media.data;
      const at = timestamp === undefined ? Number.NaN : Date.parse(timestamp);
      if (
        (type === undefined || type === product) &&
        (story || (media.data.caption ?? "").trim() === caption) &&
        (Number.isNaN(at) || at >= since)
      ) {
        matches.push(permalink === undefined ? { id } : { id, permalink });
        if (!story) {
          break;
        }
      }
    }
    return matches.length === 1 ? (matches[0] ?? null) : null;
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
   * Runs `send` for `key` at most once per process: a concurrent or repeated call waits for (or
   * reuses) the first one. A failed call is forgotten, so it may be retried.
   */
  function once(
    calls: Map<string, Promise<string>>,
    key: string,
    send: () => Promise<string>,
  ): Promise<string> {
    const existing = calls.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const sent = send();
    calls.set(key, sent);
    sent.catch(() => {
      if (calls.get(key) === sent) {
        calls.delete(key);
      }
    });
    if (calls.size > MAX_REMEMBERED_PUBLISHES) {
      const oldest = calls.keys().next().value;
      if (oldest !== undefined && oldest !== key) {
        calls.delete(oldest);
      }
    }
    return sent;
  }

  /** Sends `media_publish` for `containerId` at most once per process (see `once`). */
  function publishOnce(call: LiveCall, containerId: string): Promise<string> {
    return once(publishes, containerId, () => {
      const [, publishStep] = buildInstagramFinish(call.igUserId, containerId, call);
      if (publishStep === undefined) {
        throw new Error("the Instagram finish plan has no media_publish step");
      }
      return sendStep<unknown>(call.client, publishStep, { ...call, raw: true }).then(
        (response) => IdSchema.parse(response.data).id,
      );
    });
  }

  /** Reads a container's status. */
  async function containerStatus(call: LiveCall, containerId: string): Promise<Container> {
    const [statusStep] = buildInstagramFinish(call.igUserId, containerId, call);
    if (statusStep === undefined) {
      throw new Error("the Instagram finish plan has no status step");
    }
    const response = await sendStep<unknown>(call.client, statusStep, call);
    const parsed = ContainerSchema.safeParse(response.data);
    return parsed.success ? parsed.data : {};
  }

  /**
   * The status of a staged carousel: pending while an item processes, failed when one failed,
   * and, once every item is FINISHED, pending on the new carousel container.
   */
  async function stagedStatus(
    call: LiveCall,
    context: PublishContext,
    stagedId: string,
    itemIds: readonly string[],
  ): Promise<StatusResult> {
    const codes: (string | null)[] = [];
    for (const [index, itemId] of itemIds.entries()) {
      const item = await containerStatus(call, itemId);
      const code = item.status_code ?? null;
      codes.push(code);
      if (code === "ERROR" || code === "EXPIRED") {
        context.record({
          response: {
            item_container_ids: [...itemIds],
            item_status_codes: codes,
            status: item.status ?? null,
          },
        });
        return containerFailure(code, item.status, "carousel", index);
      }
    }
    if (codes.some((code) => code !== "FINISHED")) {
      context.record({
        response: { item_container_ids: [...itemIds], item_status_codes: codes },
      });
      return { state: "pending" };
    }
    const parent = instagramRequests.createCarouselContainer(
      {
        externalId: call.igUserId,
        caption: context.caption().text,
        ...(Object.keys(context.post.options).length === 0
          ? {}
          : { options: context.post.options }),
      },
      itemIds,
      call,
    );
    const containerId = await once(carousels, stagedId, async () => {
      const created = await sendStep<unknown>(call.client, parent, call);
      return createdId(created.data, "carousel container");
    });
    context.record({
      response: {
        item_container_ids: [...itemIds],
        item_status_codes: codes,
        container_id: containerId,
      },
    });
    return { state: "pending", containerId };
  }

  /** Sends the create steps of `plan` and returns the container id the post waits on. */
  async function createContainers(
    call: LiveCall,
    context: PublishContext,
    steps: readonly PlatformRequest[],
  ): Promise<{ containerId: string; record: JsonObject }> {
    if (context.media.format === "carousel") {
      const itemSteps = steps.filter((step) => step.step === "create_item_container");
      if (itemSteps.length === 0) {
        throw new Error("the Instagram carousel plan has no item containers");
      }
      const itemIds: string[] = [];
      // One at a time, in order: the carousel shows its items in the order of `children`.
      for (const step of itemSteps) {
        const created = await sendStep<unknown>(call.client, step, call);
        itemIds.push(createdId(created.data, `container of item ${itemIds.length + 1}`));
      }
      return {
        containerId: stagedCarouselId(itemIds),
        record: { item_container_ids: itemIds },
      };
    }
    const createStep = steps.find((step) => step.step === "create_container");
    if (createStep === undefined) {
      throw new Error("the Instagram publish plan has no create_container step");
    }
    const created = await sendStep<unknown>(call.client, createStep, call);
    const containerId = createdId(created.data, "container");
    return { containerId, record: { container_id: containerId } };
  }

  return {
    platform: "instagram",

    async validate(context): Promise<AdapterIssue[]> {
      return validateInstagramPost(context);
    },

    async publish(context): Promise<PublishResult> {
      const call = await liveCall(context);

      // A post whose earlier container was published (the outcome was lost) is not posted again.
      // A staged carousel was never published: its items are left to expire.
      if (context.post.externalId !== null || context.post.externalContainerId !== null) {
        const previous = context.post.externalContainerId;
        const code =
          previous === null
            ? "PUBLISHED"
            : stagedItemIds(previous) !== null
              ? undefined
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

      // The quota is checked before the media are copied to public storage: every copy is new,
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
      const created = await createContainers(call, context, plan.steps);
      context.record({ response: { ...quotaRecord(quota), ...created.record } });
      return { pending: true, containerId: created.containerId };
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
      const itemIds = stagedItemIds(containerId);
      if (itemIds !== null) {
        return stagedStatus(call, context, containerId, itemIds);
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
          return containerFailure(code, container.status, context.media.format);
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
