import type { JsonObject } from "@loomcast/contracts";
import { z } from "zod";
import type { GraphClient } from "../../../../lib/meta-graph";
import { PublishFailure } from "../../errors";
import { buildInstagramPublish, instagramRequests } from "../../requests";
import type {
  AdapterIssue,
  PublishContext,
  PublisherAdapter,
  PublishResult,
  StatusResult,
} from "../../types";
import { type GraphClientSource, graphClientFromEnv, lazyGraphClient, sendStep } from "./graph";
import { checkQuota, quotaRecord } from "./quota";
import { validateInstagramReel } from "./validate";

// The live Instagram Reels adapter (Instagram API with Facebook Login, Graph API v26.0):
// `publish` checks the account's 24-hour quota, copies the render to public storage and creates
// a Reels container from its URL (`POST /{ig-user-id}/media`, `media_type=REELS`,
// `share_to_feed=true`), then reports the post pending with the container id.
// Every request is built by `requests/instagram.ts`, so it matches what a dry run records.

const IdSchema = z.object({ id: z.coerce.string().min(1) });

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

export function createInstagramAdapter(options: InstagramAdapterOptions = {}): PublisherAdapter {
  const client = lazyGraphClient(options.client ?? (() => graphClientFromEnv()));

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

  return {
    platform: "instagram",

    async validate(context): Promise<AdapterIssue[]> {
      return validateInstagramReel(context);
    },

    async publish(context): Promise<PublishResult> {
      const call = await liveCall(context);

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
        media: { bytes: context.media.bytes, mime: context.media.mime },
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

    async status(): Promise<StatusResult> {
      throw PublishFailure.of("not_configured", "Instagram status polling is not available yet.", {
        retryable: false,
      });
    },
  };
}
