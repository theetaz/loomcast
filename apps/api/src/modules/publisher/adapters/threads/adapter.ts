import { type JsonObject, PermalinkSchema } from "@loomcast/contracts";
import { createThreadsGraphClient, type GraphClient, parseGraph } from "../../../../lib/meta-graph";
import { PublishFailure } from "../../errors";
import {
  buildThreadsFinish,
  buildThreadsPublish,
  threadsRequests,
  validateThreadsRequest,
} from "../../requests/threads";
import type {
  AdapterIssue,
  PublishContext,
  PublisherAdapter,
  PublishResult,
  StatusResult,
} from "../../types";
import {
  clientOptions,
  credentialsOf,
  type MetaAdapterOptions,
  metaCall,
  stepOf,
  toGraphRequest,
} from "../facebook/meta-call";
import { assertThreadsQuota, ThreadsQuotaSchema } from "./quota";
import {
  ThreadsContainerSchema,
  ThreadsIdSchema,
  ThreadsPermalinkSchema,
  threadsContainerState,
} from "./status";

// The live Threads adapter. `publish` sends what `buildThreadsPublish` builds: the 24-hour quota
// (`GET /{threads-user-id}/threads_publishing_limit?fields=quota_usage,config`), then a VIDEO
// container from the public copy of the render (`POST /{threads-user-id}/threads {media_type:
// "VIDEO", video_url, text}`), and the post is pending. `status` sends what `buildThreadsFinish`
// builds: `GET /{container-id}?fields=status,error_message` until the container is FINISHED, then
// `POST /{threads-user-id}/threads_publish {creation_id}` and `GET /{media-id}?fields=permalink`.
// The Threads API takes the token as the `access_token` parameter; the client places it.

/** The live Threads adapter with `options`. */
export function createThreadsAdapter(options: MetaAdapterOptions): PublisherAdapter {
  const client: GraphClient = createThreadsGraphClient(options.platforms, clientOptions(options));

  async function permalinkOf(
    context: PublishContext,
    mediaId: string,
    accessToken: string,
  ): Promise<string | undefined> {
    const step = threadsRequests.permalink(mediaId, { accessToken });
    try {
      const media = await metaCall(context, options, step.step, async () =>
        parseGraph(
          ThreadsPermalinkSchema,
          await client.request(toGraphRequest(step, accessToken, context.signal)),
          "the permalink",
        ),
      );
      const permalink = media.permalink?.trim() ?? "";
      return permalink.startsWith("https://") && PermalinkSchema.safeParse(permalink).success
        ? permalink
        : undefined;
    } catch (error) {
      if (context.signal.aborted) {
        throw error;
      }
      // The post is out; a missing permalink must not make the publisher retry it.
      context.logger.warn({ mediaId }, "the Threads post was published without a permalink");
      return undefined;
    }
  }

  return {
    platform: "threads",

    async validate(context): Promise<AdapterIssue[]> {
      const request = await context.publishRequest();
      return [
        ...validateThreadsRequest(request, context.media),
        ...context.caption().issues.map((issue) => ({ field: "caption", message: issue.message })),
      ];
    },

    async publish(context): Promise<PublishResult> {
      const { accessToken } = await credentialsOf(context, options);
      const request = await context.publishRequest();
      const plan = buildThreadsPublish({
        request,
        media: { bytes: context.media.bytes, mime: context.media.mime },
        accessToken,
      });
      context.record({ request: plan as unknown as JsonObject });

      // The quota first: a full quota waits rather than creating a container that cannot post.
      const limit = stepOf(plan.steps, "publishing_limit");
      const quota = await metaCall(context, options, limit.step, async () =>
        parseGraph(
          ThreadsQuotaSchema,
          await client.request(toGraphRequest(limit, accessToken, context.signal)),
          "the publishing quota",
        ),
      );
      const usage = quota.data[0];
      context.record({
        response: {
          quota_usage: usage?.quota_usage ?? null,
          quota_total: usage?.config?.quota_total ?? null,
        },
      });
      assertThreadsQuota(quota);

      const create = stepOf(plan.steps, "create_container");
      const container = await metaCall(context, options, create.step, async () =>
        parseGraph(
          ThreadsIdSchema,
          await client.request(toGraphRequest(create, accessToken, context.signal)),
          "the container",
        ),
      );
      context.record({ response: { container_id: container.id } });
      return { pending: true, containerId: container.id };
    },

    async status(context): Promise<StatusResult> {
      const containerId = context.post.externalContainerId;
      if (containerId === null) {
        throw PublishFailure.of("permanent", "The post has no container to check.", {
          retryable: false,
        });
      }
      const userId = context.channel.externalId;
      if (userId === null) {
        throw PublishFailure.of("not_configured", "The channel has no platform account.", {
          retryable: false,
        });
      }
      const { accessToken } = await credentialsOf(context, options);
      const steps = buildThreadsFinish(userId, containerId, { accessToken });

      const check = stepOf(steps, "container_status");
      const container = await metaCall(context, options, check.step, async () =>
        parseGraph(
          ThreadsContainerSchema,
          await client.request(toGraphRequest(check, accessToken, context.signal)),
          "the container status",
        ),
      );
      const state = threadsContainerState(container);
      if (state !== "ready") {
        if (state.state === "published") {
          // Published by an earlier poll whose outcome was lost: never publish it twice.
          context.logger.warn({ containerId }, "the Threads container was already published");
        }
        context.record({
          response: {
            container_id: containerId,
            status: container.status ?? null,
            ...(container.error_message === undefined
              ? {}
              : { error_message: container.error_message }),
          },
        });
        return state;
      }

      const publish = stepOf(steps, "threads_publish");
      const media = await metaCall(context, options, publish.step, async () =>
        parseGraph(
          ThreadsIdSchema,
          await client.request(toGraphRequest(publish, accessToken, context.signal)),
          "the published post",
        ),
      );
      const permalink = await permalinkOf(context, media.id, accessToken);
      context.record({
        response: {
          container_id: containerId,
          status: "FINISHED",
          media_id: media.id,
          ...(permalink === undefined ? {} : { permalink }),
        },
      });
      return {
        state: "published",
        externalId: media.id,
        ...(permalink === undefined ? {} : { permalink }),
      };
    },
  };
}
