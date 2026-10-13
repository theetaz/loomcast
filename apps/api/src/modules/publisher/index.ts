import { type PublisherStatus, routes } from "@loomcast/contracts";
import { publishAttempts, scheduledPosts } from "@loomcast/db";
import { desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import type { ModuleDeps } from "../../deps";
import { notFound } from "../../lib/errors";
import { idParam } from "../../lib/http";
import { createMetaGraphClient } from "../../lib/meta-graph";
import type { AppEnv } from "../../types";
import { currentUser } from "../auth/guards";
import { flagNeedsReauth } from "../channels/reauth";
import { contentServiceFor } from "../content";
import { enqueueInsightsPulls } from "../insights/schedule";
import { publisherAdapters } from "./adapters";
import { createFacebookAdapter, type MetaAdapterOptions } from "./adapters/facebook";
import { createInstagramAdapter } from "./adapters/instagram";
import { createThreadsAdapter } from "./adapters/threads";
import { createXAdapter, storageMediaSource } from "./adapters/x";
import { PublishFailure } from "./errors";
import { toPublishAttempt } from "./posts";
import { createUsageObserver } from "./rate-limit";
import { registerPublisherTasks } from "./tasks";

export {
  type AdapterRegistry,
  createDryRunAdapter,
  DRY_RUN_MEDIA_ORIGIN,
  dryRunMediaUrl,
  isLivePlatformAvailable,
  notConfiguredAdapter,
  publisherAdapters,
} from "./adapters";
export {
  buildCaption,
  type CaptionParts,
  captionLength,
  type FittedCaption,
  limitCaption,
  PLATFORM_CAPTION_LIMITS,
  X_LINK_LENGTH,
  xWeightedLength,
} from "./caption";
export { createPublishContext } from "./context";
export { isRetryableCode, PublishFailure, publishError, toPublishError } from "./errors";
export {
  checkRateGate,
  isDryRun,
  type LiveGateSettings,
  livePublishingBlocker,
  PLATFORM_DAILY_POST_LIMITS,
  RATE_WINDOW_MS,
} from "./gates";
export { loadScheduledPost, loadScheduledPosts, toPublishAttempt, toScheduledPost } from "./posts";
export {
  createUsageObserver,
  META_USAGE_WINDOW_MS,
  RATE_LIMITED_FALLBACK_MS,
  rateLimitedRetryMs,
  recordChannelUsage,
  type Throttle,
  throttleOf,
  USAGE_THROTTLE_PERCENT,
  type UsageObserver,
  type UsageScope,
} from "./rate-limit";
export { REDACTED, redactRequest } from "./redact";
export * from "./requests";
export {
  type LivePublishedPost,
  PUBLISHING_PAUSED_RETRY_MS,
  type PublisherDeps,
  registerPublisherTasks,
  statusDedupeKey,
  statusPollDelayMs,
} from "./tasks";
export type * from "./types";

/**
 * Publisher: the `post.publish` and `post.check_status` task handlers, the publisher status and
 * the attempts of a post. While `PUBLISHING_MODE` is `dry-run` (or the post or its channel is in
 * dry-run) every post goes through the dry-run adapter, which records the request a live run
 * would send and contacts nobody.
 */
export function register(app: Hono<AppEnv>, deps: ModuleDeps): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  const logger = deps.logger.child({ module: "publisher" });
  // The live Meta adapters sign calls with the server's platform settings; a channel whose
  // credentials the platform refuses turns `needs_reauth` through the channels module. Their
  // calls go through the usage observer, so each attempt's throttling headers reach the channel.
  const usage = createUsageObserver();
  const meta: MetaAdapterOptions = {
    platforms: deps.config.platforms,
    fetch: usage.fetch,
    onCredentialsRefused: async ({ channelId, error, reason }) => {
      await flagNeedsReauth(deps, logger, { channelId, error, reason });
    },
  };
  registerPublisherTasks({
    db: deps.db,
    bus: deps.bus,
    logger,
    config: deps.config,
    storage: deps.storage,
    vault: deps.vault,
    assets: deps.assets,
    scheduler: deps.scheduler,
    content: contentServiceFor(deps),
    alert: deps.alert,
    usage,
    onLivePublished: async (tx, post) => {
      await enqueueInsightsPulls(deps.scheduler, tx, post);
    },
    adapters: {
      ...publisherAdapters,
      instagram: createInstagramAdapter({
        client: () => {
          if (deps.config.platforms.meta === null) {
            throw PublishFailure.of(
              "not_configured",
              "The Meta app is not configured on the server.",
              {
                retryable: false,
              },
            );
          }
          return createMetaGraphClient(deps.config.platforms, { fetch: usage.fetch });
        },
      }),
      facebook: createFacebookAdapter(meta),
      threads: createThreadsAdapter(meta),
      // Refuses every post with `not_configured` unless `FEATURE_X_PUBLISHING` is on and the X
      // client credentials are set; otherwise it reads the rotating token pair from the vault
      // and streams the render from the private bucket.
      x: createXAdapter({
        platforms: deps.config.platforms,
        tokens: { db: deps.db, vault: deps.vault },
        media: storageMediaSource({ storage: deps.storage, assets: deps.assets }),
        onCredentialsRefused: async ({ channelId, error, reason }) => {
          await flagNeedsReauth(deps, logger, { channelId, error, reason });
        },
      }),
    },
  });

  router.get(routes["publisher.status"].path, (c) => {
    currentUser(c);
    const status: PublisherStatus = {
      mode: deps.config.publishing.mode,
      enabled: deps.config.publishing.enabled,
      lastTickAt: deps.scheduler.health().lastTickAt,
    };
    c.header("Cache-Control", "no-store");
    return c.json(status, 200);
  });

  router.get(routes["scheduledPosts.attempts"].path, async (c) => {
    currentUser(c);
    const id = idParam(c);
    const [post] = await deps.db
      .select({ id: scheduledPosts.id })
      .from(scheduledPosts)
      .where(eq(scheduledPosts.id, id));
    if (post === undefined) {
      throw notFound("No scheduled post has that id.");
    }
    const rows = await deps.db
      .select()
      .from(publishAttempts)
      .where(eq(publishAttempts.postId, id))
      .orderBy(desc(publishAttempts.attempt));
    c.header("Cache-Control", "no-store");
    return c.json({ items: rows.map(toPublishAttempt) }, 200);
  });

  app.route("/", router);
  return router;
}
