import type { PublishError } from "@loomcast/contracts";
import {
  channels,
  contentItems,
  contentVersions,
  type Database,
  postMetrics,
  scheduledPosts,
} from "@loomcast/db";
import { and, eq, gte } from "drizzle-orm";
import type { EventBus } from "../../lib/bus";
import { afterCommit, transaction } from "../../lib/db";
import type { Logger } from "../../lib/logger";
import {
  createMetaGraphClient,
  createThreadsGraphClient,
  type FetchLike,
  type GraphClient,
  type GraphClientOptions,
  type GraphResponse,
  MetaGraphError,
} from "../../lib/meta-graph";
import { channelAad, sealedSecretOf, type TokenVault } from "../../lib/vault";
import { toPostMetrics } from "../analytics/mappers";
import type { MetaPlatforms } from "../publisher/adapters/facebook";
import { rateLimitedRetryMs, recordChannelUsage, throttleOf } from "../publisher/rate-limit";
import { type Scheduler, TaskFailure, type TaskResult } from "../scheduler";
import { insightsExpired, insightsRequest, normalizeInsights, supportsInsights } from "./normalize";

// The `insights.pull` handler. Each run captures one snapshot of a live post's insights into a
// new `post_metrics` row and publishes `post.metrics.updated`. A run does nothing for a post that
// is no longer live, a format the platform reports nothing for (`insightsRequest`), a story past
// its 24-hour insights window, a channel without working credentials, or a time an earlier
// overdue run already covered. While the channel is near its platform rate limit the run moves to
// the end of the reported window; a rate-limit error holds the channel back for the back-off as
// well.

export interface InsightsDeps {
  db: Database;
  bus: EventBus;
  logger: Logger;
  scheduler: Scheduler;
  vault: TokenVault;
  platforms: MetaPlatforms;
  /** Replaces the global `fetch`; tests pass a scripted one. */
  fetch?: FetchLike;
  /** Waits between the client's retries; tests pass one that returns at once. */
  sleep?: GraphClientOptions["sleep"];
  /** Told when the platform refuses the channel's credentials (`auth` or `permission`). */
  onCredentialsRefused?: (input: { channelId: string; error: PublishError }) => Promise<void>;
}

export function registerInsightsTasks(deps: InsightsDeps): void {
  const { db, bus, scheduler } = deps;
  const options: Partial<GraphClientOptions> = {
    ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
    ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
  };
  const graph: GraphClient = createMetaGraphClient(deps.platforms, options);
  const threads: GraphClient = createThreadsGraphClient(deps.platforms, options);

  scheduler.register(
    "insights.pull",
    async ({
      payload,
      task,
      signal,
      logger,
      now,
    }): Promise<TaskResult<"insights.pull"> | undefined> => {
      const log = logger.child({ postId: payload.postId });
      const [row] = await db
        .select({
          postId: scheduledPosts.id,
          status: scheduledPosts.status,
          dryRun: scheduledPosts.dryRun,
          externalId: scheduledPosts.externalId,
          publishedAt: scheduledPosts.publishedAt,
          format: contentVersions.format,
          itemId: scheduledPosts.itemId,
          projectId: contentItems.projectId,
          channelId: channels.id,
          platform: channels.platform,
          channelStatus: channels.status,
          rateLimit: channels.rateLimit,
          secretCiphertext: channels.secretCiphertext,
          secretNonce: channels.secretNonce,
          keyVersion: channels.keyVersion,
        })
        .from(scheduledPosts)
        .innerJoin(channels, eq(channels.id, scheduledPosts.channelId))
        .innerJoin(contentItems, eq(contentItems.id, scheduledPosts.itemId))
        .leftJoin(contentVersions, eq(contentVersions.id, scheduledPosts.versionId))
        .where(eq(scheduledPosts.id, payload.postId));
      if (
        row === undefined ||
        row.status !== "published" ||
        row.dryRun ||
        row.externalId === null ||
        !supportsInsights(row.platform)
      ) {
        log.info("the post has no insights to pull");
        return;
      }
      const format = row.format ?? "reel";
      const call = insightsRequest(row.platform, row.externalId, format);
      if (call === null) {
        log.info({ format }, "the platform reports no insights for this format");
        return;
      }
      if (insightsExpired(format, row.publishedAt, now())) {
        log.info({ format }, "the post's insights have expired");
        return;
      }
      const sealed = sealedSecretOf(row);
      if (row.channelStatus !== "active" || sealed === null) {
        log.info({ channelId: row.channelId }, "the channel cannot be asked for insights now");
        return;
      }
      if (row.platform !== "threads" && deps.platforms.meta === null) {
        log.warn("the Meta app is not configured; insights are skipped");
        return;
      }

      // An earlier overdue run that captured after this time already covers it.
      const [covered] = await db
        .select({ id: postMetrics.id })
        .from(postMetrics)
        .where(and(eq(postMetrics.postId, row.postId), gte(postMetrics.capturedAt, task.runAt)))
        .limit(1);
      if (covered !== undefined) {
        log.debug("a later capture already covers this time");
        return;
      }

      const startedAt = now();
      const throttle = throttleOf(row.rateLimit, startedAt);
      if (throttle !== null) {
        log.info(
          { until: throttle.until, dimension: throttle.dimension },
          "the channel is near its rate limit; insights wait",
        );
        return { next: throttle.until };
      }

      let accessToken: string;
      try {
        const secret = deps.vault.decrypt(sealed, channelAad(row.channelId));
        if (typeof secret.accessToken !== "string" || secret.accessToken === "") {
          throw new Error("no access token");
        }
        accessToken = secret.accessToken;
      } catch {
        log.warn({ channelId: row.channelId }, "the channel's credentials cannot be read");
        return;
      }

      const client = call.api === "threads" ? threads : graph;
      let response: GraphResponse<unknown>;
      try {
        response = await client.request<unknown>({
          method: "GET",
          path: call.path,
          query: call.query,
          accessToken,
          signal,
        });
      } catch (error) {
        if (signal.aborted || !(error instanceof MetaGraphError)) {
          throw error;
        }
        const failure = error.error;
        const at = now();
        log.warn({ ...error.toLog(), channelId: row.channelId }, "an insights call failed");
        await recordChannelUsage(db, row.channelId, { usage: error.usage, at });
        if (failure.code === "rate_limited") {
          const [fresh] = await db
            .select({ rateLimit: channels.rateLimit })
            .from(channels)
            .where(eq(channels.id, row.channelId));
          const retryMs = rateLimitedRetryMs(failure, fresh?.rateLimit ?? null, at);
          const until = new Date(at.getTime() + retryMs);
          await recordChannelUsage(db, row.channelId, { blockedUntil: until, at });
          return { next: until };
        }
        if (failure.code === "auth" || failure.code === "permission") {
          try {
            await deps.onCredentialsRefused?.({
              channelId: row.channelId,
              error: { ...failure, retryable: false },
            });
          } catch (thrown) {
            log.error({ err: thrown }, "could not flag the channel for reconnecting");
          }
          throw new TaskFailure(failure.code, failure.message, { retryable: false });
        }
        throw new TaskFailure(failure.code, failure.message, {
          retryable: failure.retryable,
          ...(failure.retryAfterMs === undefined ? {} : { retryAfterMs: failure.retryAfterMs }),
        });
      }

      const normalized = normalizeInsights(row.platform, response.data);
      const capturedAt = now();
      const channelId = row.channelId;
      const platform = row.platform;
      await transaction(db, async (tx) => {
        await recordChannelUsage(tx, channelId, { usage: response.usage, at: capturedAt });
        const [inserted] = await tx
          .insert(postMetrics)
          .values({
            postId: row.postId,
            capturedAt,
            views: normalized.views,
            likes: normalized.likes,
            comments: normalized.comments,
            shares: normalized.shares,
            saves: normalized.saves,
            reach: normalized.reach,
            avgWatchMs: normalized.avgWatchMs,
            raw: normalized.raw,
          })
          .returning();
        if (inserted === undefined) {
          throw new Error("the capture was not stored");
        }
        const metrics = toPostMetrics(inserted);
        afterCommit(tx, () =>
          bus.publish({
            type: "post.metrics.updated",
            payload: {
              postId: row.postId,
              itemId: row.itemId,
              projectId: row.projectId,
              channelId,
              platform,
              metrics,
            },
          }),
        );
      });
      log.info({ views: normalized.views }, "captured the post's insights");
      return undefined;
    },
  );
}
