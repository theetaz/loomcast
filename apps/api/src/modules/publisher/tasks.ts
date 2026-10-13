import {
  DEFAULT_FORMAT_RULES,
  type FormatRules,
  type JsonObject,
  PermalinkSchema,
  type Platform,
  POST_STATUS_POLL_INITIAL_MS,
  POST_STATUS_POLL_MAX_MS,
  POST_STATUS_TIMEOUT_MS,
  type PublishError,
  type PublishingMode,
  scheduledTaskRegistry,
} from "@loomcast/contracts";
import {
  type AssetRow,
  assets,
  type ChannelRow,
  channels,
  contentItems,
  contentVersions,
  type Database,
  formatVersions,
  type PublishAttemptRow,
  publishAttempts,
  type ScheduledPostRow,
  scheduledPosts,
} from "@loomcast/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { audit } from "../../lib/audit";
import type { EventBus } from "../../lib/bus";
import { afterCommit, type Executor, type Transaction, transaction } from "../../lib/db";
import { HttpError } from "../../lib/errors";
import type { Logger } from "../../lib/logger";
import type { Storage } from "../../lib/storage";
import type { TokenVault } from "../../lib/vault";
import type { AssetsService } from "../assets/service";
import { type ContentService, SYSTEM_ACTOR } from "../content";
import { type Scheduler, type SchedulerAlert, TaskFailure, type TaskResult } from "../scheduler";
import { type AdapterRegistry, createDryRunAdapter, publisherAdapters } from "./adapters";
import type { CaptionParts } from "./caption";
import { createPublishContext, type RecordedExchange } from "./context";
import { PublishFailure, publishError, toPublishError } from "./errors";
import { checkRateGate, isDryRun, livePublishingBlocker } from "./gates";
import { loadScheduledPost } from "./posts";
import type {
  PublishChannel,
  PublisherAdapter,
  PublishMedia,
  PublishPost,
  PublishResult,
} from "./types";

// The `post.publish` and `post.check_status` task handlers.
//
// `post.publish` runs at a post's time. Under a row lock it settles the post's status (a planned
// post is missed, a cancelled or finished one is left alone), waits while publishing is paused,
// and checks the approval, channel and rate gates. It then marks the post `publishing`, numbers
// a new attempt (in step with `scheduled_posts.attempts`) and commits, so no lock is held while
// the adapter talks to the platform. The outcome is written in a second transaction: published
// (and the item with it, on its first published post), pending (then `post.check_status` polls),
// back to queued for a retry, or failed with an event and an alert.

/** How long due posts wait while `PUBLISHING_ENABLED` is false. */
export const PUBLISHING_PAUSED_RETRY_MS = 15 * 60_000;

/** Dedupe key of a post's status polling task. */
export function statusDedupeKey(postId: string): string {
  return `status:${postId}`;
}

/** Delay before the next status poll: 15 s at first, growing with the wait to 60 s. */
export function statusPollDelayMs(elapsedMs: number): number {
  return Math.min(
    POST_STATUS_POLL_MAX_MS,
    Math.max(POST_STATUS_POLL_INITIAL_MS, Math.round(elapsedMs / 4)),
  );
}

export interface PublisherDeps {
  db: Database;
  bus: EventBus;
  logger: Logger;
  config: { publishing: { mode: PublishingMode; enabled: boolean } };
  storage: Storage;
  vault: TokenVault;
  assets: Pick<AssetsService, "getRow">;
  scheduler: Scheduler;
  content: Pick<ContentService, "transition">;
  /** Receives post failure alerts; without it they are logged at error level. */
  alert?: (alert: SchedulerAlert) => void | Promise<void>;
  /** The live adapters; tests pass fakes. */
  adapters?: AdapterRegistry;
  /** Overrides `PLATFORM_DAILY_POST_LIMITS`; tests pass small ones. */
  dailyLimits?: Partial<Record<Platform, number>>;
}

/** Everything an adapter call needs, loaded from the database. */
interface PublishInputs {
  channel: PublishChannel;
  channelRow: Pick<ChannelRow, "status" | "dryRun"> & { connected: boolean };
  media: PublishMedia;
  captionParts: CaptionParts;
}

/** A post ready for its adapter: marked `publishing` with an open attempt. */
interface Started {
  post: ScheduledPostRow;
  attempt: PublishAttemptRow;
  inputs: PublishInputs;
  dryRun: boolean;
}

type Settled =
  | { kind: "done" }
  | { kind: "paused" }
  | { kind: "rate_limited"; retryAfterMs: number }
  | { kind: "start"; started: Started };

const channelColumns = {
  id: channels.id,
  platform: channels.platform,
  displayName: channels.displayName,
  externalId: channels.externalId,
  username: channels.username,
  parentChannelId: channels.parentChannelId,
  scopes: channels.scopes,
  meta: channels.meta,
  status: channels.status,
  dryRun: channels.dryRun,
  connected: sql<boolean>`${channels.secretCiphertext} is not null`,
};

function mediaOf(render: AssetRow, posterAssetId: string | null): PublishMedia {
  const probe = render.meta.probe;
  return {
    renderAssetId: render.id,
    mime: render.mime,
    bytes: render.bytes,
    sha256: render.sha256,
    durationMs: render.durationMs ?? probe?.durationMs ?? null,
    width: render.width ?? probe?.width ?? null,
    height: render.height ?? probe?.height ?? null,
    posterAssetId,
  };
}

/** The final failure the publisher records when an attempt cannot even start. */
function gateFailure(error: PublishError): PublishFailure {
  return new PublishFailure({ ...error, retryable: false });
}

/**
 * Loads the channel, the approved version's render and caption parts of `post`. Throws a
 * `PublishFailure` when the version has no ready render.
 */
async function loadInputs(
  executor: Executor,
  post: ScheduledPostRow,
  options: { lockChannel?: boolean } = {},
): Promise<PublishInputs> {
  const channelQuery = executor
    .select(channelColumns)
    .from(channels)
    .where(eq(channels.id, post.channelId));
  const [channel] = options.lockChannel
    ? await channelQuery.for("update", { of: channels })
    : await channelQuery;
  if (channel === undefined) {
    throw gateFailure(publishError("not_configured", "The channel no longer exists."));
  }
  if (post.versionId === null) {
    throw gateFailure(publishError("permanent", "The post has no approved version."));
  }
  const [version] = await executor
    .select({
      caption: contentVersions.caption,
      script: contentVersions.script,
      renderAssetId: contentVersions.renderAssetId,
      posterAssetId: contentVersions.posterAssetId,
      rules: formatVersions.rules,
    })
    .from(contentVersions)
    .leftJoin(formatVersions, eq(formatVersions.id, contentVersions.formatVersionId))
    .where(and(eq(contentVersions.id, post.versionId), eq(contentVersions.itemId, post.itemId)));
  if (version === undefined || version.renderAssetId === null) {
    throw gateFailure(publishError("invalid_media", "The approved version has no render."));
  }
  const [render] = await executor.select().from(assets).where(eq(assets.id, version.renderAssetId));
  if (render === undefined || render.status !== "ready") {
    throw gateFailure(publishError("invalid_media", "The render is not stored."));
  }
  const rules: FormatRules = version.rules ?? DEFAULT_FORMAT_RULES;
  const script = version.script;
  return {
    channel: {
      id: channel.id,
      platform: channel.platform,
      displayName: channel.displayName,
      externalId: channel.externalId,
      username: channel.username,
      parentChannelId: channel.parentChannelId,
      scopes: channel.scopes,
      meta: channel.meta,
    },
    channelRow: { status: channel.status, dryRun: channel.dryRun, connected: channel.connected },
    media: mediaOf(render, version.posterAssetId),
    captionParts: {
      text: version.caption ?? script?.caption ?? "",
      cta: rules.caption.cta ?? null,
      hashtags: [...(script?.hashtags ?? []), ...rules.caption.hashtags],
    },
  };
}

export function registerPublisherTasks(deps: PublisherDeps): void {
  const { db, bus, scheduler } = deps;
  const live = deps.adapters ?? publisherAdapters;
  const dryRunAdapters = new Map<Platform, PublisherAdapter>();
  const maxPublishAttempts = scheduledTaskRegistry["post.publish"].maxAttempts;
  const maxStatusAttempts = scheduledTaskRegistry["post.check_status"].maxAttempts;

  function adapterFor(platform: Platform, dryRun: boolean): PublisherAdapter {
    if (!dryRun) {
      return live[platform];
    }
    let adapter = dryRunAdapters.get(platform);
    if (adapter === undefined) {
      adapter = createDryRunAdapter(platform);
      dryRunAdapters.set(platform, adapter);
    }
    return adapter;
  }

  async function raiseAlert(alert: SchedulerAlert): Promise<void> {
    try {
      if (deps.alert === undefined) {
        deps.logger.error({ alert: alert.key, ...alert.data }, alert.title);
      } else {
        await deps.alert(alert);
      }
    } catch (error) {
      deps.logger.error({ err: error, alert: alert.key }, "could not send a publisher alert");
    }
  }

  /** Publishes `post.updated` with the post as it is in `tx`, once `tx` commits. */
  async function emitPost(tx: Transaction, postId: string): Promise<void> {
    const post = await loadScheduledPost(tx, postId);
    if (post !== null) {
      afterCommit(tx, () => bus.publish({ type: "post.updated", payload: { post } }));
    }
  }

  async function lockPost(tx: Transaction, postId: string): Promise<ScheduledPostRow | null> {
    const [row] = await tx
      .select()
      .from(scheduledPosts)
      .where(eq(scheduledPosts.id, postId))
      .for("update", { of: scheduledPosts });
    return row ?? null;
  }

  async function finishAttempt(
    tx: Transaction,
    attemptId: string,
    fields: { recorded?: RecordedExchange; error?: PublishError | null; finished: Date | null },
  ): Promise<void> {
    await tx
      .update(publishAttempts)
      .set({
        ...(fields.recorded?.request == null ? {} : { request: fields.recorded.request }),
        ...(fields.recorded?.response == null ? {} : { response: fields.recorded.response }),
        ...(fields.error === undefined ? {} : { error: fields.error }),
        finishedAt: fields.finished,
      })
      .where(eq(publishAttempts.id, attemptId));
  }

  /** Fails `post` for good: status, attempt, audit, event and an alert after commit. */
  async function failPost(
    tx: Transaction,
    post: ScheduledPostRow,
    error: PublishError,
    options: { attemptId?: string; recorded?: RecordedExchange; now: Date },
  ): Promise<void> {
    await tx
      .update(scheduledPosts)
      .set({ status: "failed", lastError: error, updatedAt: options.now })
      .where(eq(scheduledPosts.id, post.id));
    if (options.attemptId !== undefined) {
      await finishAttempt(tx, options.attemptId, {
        recorded: options.recorded,
        error,
        finished: options.now,
      });
    }
    const data = {
      channelId: post.channelId,
      itemId: post.itemId,
      code: error.code,
      dryRun: post.dryRun,
    } satisfies JsonObject;
    await audit(tx, {
      actorKind: "system",
      action: "post.failed",
      targetType: "scheduled_post",
      targetId: post.id,
      data,
    });
    await emitPost(tx, post.id);
    afterCommit(tx, () => {
      void raiseAlert({
        key: `post.failed:${post.id}`,
        title: "post failed to publish",
        message: `Post ${post.id} failed (${error.code}): ${error.message}`,
        data: { postId: post.id, ...data },
      });
    });
  }

  /**
   * Moves the item to `published` on its first published post. An item still `approved` (no
   * calendar move scheduled it) is scheduled first; any other state is left alone.
   */
  async function publishItem(tx: Transaction, itemId: string, log: Logger): Promise<void> {
    const [item] = await tx
      .select({ state: contentItems.state })
      .from(contentItems)
      .where(eq(contentItems.id, itemId));
    if (item === undefined || (item.state !== "approved" && item.state !== "scheduled")) {
      return;
    }
    try {
      if (item.state === "approved") {
        await deps.content.transition(tx, itemId, "scheduled", SYSTEM_ACTOR, {
          via: "schedule",
          reason: "publishing",
        });
      }
      await deps.content.transition(tx, itemId, "published", SYSTEM_ACTOR, { via: "publish" });
    } catch (error) {
      if (!(error instanceof HttpError)) {
        throw error;
      }
      log.warn({ itemId, code: error.code }, "could not move the item to published");
    }
  }

  async function markPublished(
    tx: Transaction,
    post: ScheduledPostRow,
    attemptId: string,
    result: { permalink?: string; externalId?: string; containerId?: string },
    recorded: RecordedExchange,
    now: Date,
    log: Logger,
  ): Promise<void> {
    const permalink =
      result.permalink !== undefined && PermalinkSchema.safeParse(result.permalink).success
        ? result.permalink
        : null;
    await tx
      .update(scheduledPosts)
      .set({
        status: "published",
        permalink,
        externalId: result.externalId ?? post.externalId,
        externalContainerId: result.containerId ?? post.externalContainerId,
        publishedAt: now,
        lastError: null,
        updatedAt: now,
      })
      .where(eq(scheduledPosts.id, post.id));
    await finishAttempt(tx, attemptId, { recorded, error: null, finished: now });
    await audit(tx, {
      actorKind: "system",
      action: "post.published",
      targetType: "scheduled_post",
      targetId: post.id,
      data: { channelId: post.channelId, itemId: post.itemId, dryRun: post.dryRun, permalink },
    });
    await publishItem(tx, post.itemId, log);
    await emitPost(tx, post.id);
  }

  /** Settles the post under its lock and, when it may publish, opens an attempt. */
  async function settle(postId: string, now: Date, log: Logger): Promise<Settled> {
    return transaction(db, async (tx): Promise<Settled> => {
      const post = await lockPost(tx, postId);
      if (post === null) {
        log.warn({ postId }, "the post to publish no longer exists");
        return { kind: "done" };
      }
      switch (post.status) {
        case "planned": {
          await tx
            .update(scheduledPosts)
            .set({ status: "missed", updatedAt: now })
            .where(eq(scheduledPosts.id, post.id));
          await audit(tx, {
            actorKind: "system",
            action: "post.missed",
            targetType: "scheduled_post",
            targetId: post.id,
            data: { channelId: post.channelId, itemId: post.itemId },
          });
          await emitPost(tx, post.id);
          return { kind: "done" };
        }
        case "queued":
          break;
        case "publishing": {
          const [open] = await tx
            .select()
            .from(publishAttempts)
            .where(
              and(eq(publishAttempts.postId, post.id), eq(publishAttempts.attempt, post.attempts)),
            );
          if (open !== undefined && open.finishedAt === null && post.externalContainerId !== null) {
            // Processing on the platform: polling owns the post.
            await scheduler.enqueue(
              tx,
              "post.check_status",
              { postId: post.id, since: open.startedAt.toISOString() },
              { dedupeKey: statusDedupeKey(post.id), onDuplicate: "keep" },
            );
            return { kind: "done" };
          }
          if (open !== undefined && open.finishedAt === null) {
            // A run stopped before it recorded an outcome; close its attempt and start over.
            await finishAttempt(tx, open.id, {
              error: publishError("transient", "The attempt was interrupted before it finished."),
              finished: now,
            });
          }
          break;
        }
        default:
          // cancelled, published, failed, missed: nothing to do.
          return { kind: "done" };
      }

      if (!deps.config.publishing.enabled) {
        return { kind: "paused" };
      }

      let inputs: PublishInputs;
      try {
        const [item] = await tx
          .select({ state: contentItems.state, currentVersionId: contentItems.currentVersionId })
          .from(contentItems)
          .where(eq(contentItems.id, post.itemId));
        const approved =
          item !== undefined &&
          (item.state === "approved" || item.state === "scheduled" || item.state === "published") &&
          post.versionId !== null &&
          post.versionId === item.currentVersionId;
        if (!approved) {
          throw gateFailure(
            publishError(
              "permanent",
              "The item is not approved in this version; approve and schedule it again.",
            ),
          );
        }
        const mode = deps.config.publishing.mode;
        inputs = await loadInputs(tx, post, { lockChannel: true });
        if (inputs.channelRow.status === "disabled") {
          throw gateFailure(publishError("not_configured", "The channel is disabled."));
        }
        const dryRun = isDryRun(post, inputs.channelRow, mode);
        if (!dryRun) {
          const blocker = livePublishingBlocker(
            {
              platform: inputs.channel.platform,
              status: inputs.channelRow.status,
              connected: inputs.channelRow.connected,
            },
            mode,
          );
          if (blocker !== null) {
            throw gateFailure(
              blocker === "not_active" && inputs.channelRow.status === "needs_reauth"
                ? publishError("auth", "The channel needs reconnecting.")
                : publishError("not_configured", `The channel cannot publish live (${blocker}).`),
            );
          }
          const gate = await checkRateGate(tx, {
            channelId: post.channelId,
            platform: inputs.channel.platform,
            now,
            limit: deps.dailyLimits?.[inputs.channel.platform],
          });
          if (!gate.allowed) {
            await tx
              .update(scheduledPosts)
              .set({
                lastError: publishError(
                  "rate_limited",
                  `The channel reached its limit of ${gate.limit} posts in 24 hours.`,
                  { retryAfterMs: gate.retryAfterMs },
                ),
                updatedAt: now,
              })
              .where(eq(scheduledPosts.id, post.id));
            await emitPost(tx, post.id);
            return { kind: "rate_limited", retryAfterMs: gate.retryAfterMs };
          }
        }

        const attemptNo = post.attempts + 1;
        const [updated] = await tx
          .update(scheduledPosts)
          .set({ status: "publishing", attempts: attemptNo, updatedAt: now })
          .where(eq(scheduledPosts.id, post.id))
          .returning();
        const [attempt] = await tx
          .insert(publishAttempts)
          .values({
            postId: post.id,
            attempt: attemptNo,
            adapter: inputs.channel.platform,
            dryRun,
            startedAt: now,
          })
          .returning();
        if (updated === undefined || attempt === undefined) {
          throw new Error("the publish attempt was not recorded");
        }
        await emitPost(tx, post.id);
        return { kind: "start", started: { post: updated, attempt, inputs, dryRun } };
      } catch (error) {
        if (!(error instanceof PublishFailure)) {
          throw error;
        }
        await failPost(tx, post, error.error, { now });
        return { kind: "done" };
      }
    });
  }

  function contextFor(
    started: Started,
    run: { signal: AbortSignal; logger: Logger; now(): Date },
  ): ReturnType<typeof createPublishContext> {
    const { post, attempt, inputs, dryRun } = started;
    if (post.versionId === null) {
      throw new Error("a publishing post has a version");
    }
    const target: PublishPost = {
      id: post.id,
      itemId: post.itemId,
      versionId: post.versionId,
      scheduledAt: post.scheduledAt,
      attempt: attempt.attempt,
      attemptStartedAt: attempt.startedAt,
      externalId: post.externalId,
      externalContainerId: post.externalContainerId,
    };
    return createPublishContext(
      { db, vault: deps.vault, storage: deps.storage, assets: deps.assets },
      {
        dryRun,
        post: target,
        channel: inputs.channel,
        media: inputs.media,
        captionParts: inputs.captionParts,
        signal: run.signal,
        logger: run.logger,
        now: run.now,
      },
    );
  }

  /**
   * Writes the outcome of an attempt. Returns the failure to hand back to the scheduler for a
   * retry, if any. An outcome for a post that moved on meanwhile is dropped.
   */
  async function record(
    started: Started,
    outcome: { ok: true; result: PublishResult } | { ok: false; error: PublishError },
    recorded: RecordedExchange,
    taskAttempt: number,
    now: Date,
    log: Logger,
  ): Promise<TaskFailure | null> {
    return transaction(db, async (tx) => {
      const post = await lockPost(tx, started.post.id);
      if (
        post === null ||
        post.status !== "publishing" ||
        post.attempts !== started.attempt.attempt
      ) {
        log.warn({ postId: started.post.id }, "the post changed while publishing; outcome dropped");
        return null;
      }
      if (outcome.ok) {
        const { result } = outcome;
        if (!result.pending) {
          await markPublished(tx, post, started.attempt.id, result, recorded, now, log);
          return null;
        }
        await tx
          .update(scheduledPosts)
          .set({
            externalId: result.externalId ?? post.externalId,
            externalContainerId: result.containerId ?? post.externalContainerId,
            updatedAt: now,
          })
          .where(eq(scheduledPosts.id, post.id));
        await finishAttempt(tx, started.attempt.id, { recorded, finished: null });
        await scheduler.enqueue(
          tx,
          "post.check_status",
          { postId: post.id, since: started.attempt.startedAt.toISOString() },
          {
            runAt: new Date(now.getTime() + POST_STATUS_POLL_INITIAL_MS),
            dedupeKey: statusDedupeKey(post.id),
          },
        );
        await emitPost(tx, post.id);
        return null;
      }

      const { error } = outcome;
      if (error.retryable && taskAttempt < maxPublishAttempts) {
        await tx
          .update(scheduledPosts)
          .set({ status: "queued", lastError: error, updatedAt: now })
          .where(eq(scheduledPosts.id, post.id));
        await finishAttempt(tx, started.attempt.id, { recorded, error, finished: now });
        await emitPost(tx, post.id);
        return new TaskFailure(error.code, error.message, {
          retryable: true,
          retryAfterMs: error.retryAfterMs,
        });
      }
      await failPost(tx, post, error, { attemptId: started.attempt.id, recorded, now });
      return null;
    });
  }

  scheduler.register(
    "post.publish",
    async ({
      payload,
      attempt,
      signal,
      logger,
      now,
    }): Promise<TaskResult<"post.publish"> | undefined> => {
      const log = logger.child({ postId: payload.postId });
      const settled = await settle(payload.postId, now(), log);
      if (settled.kind === "paused") {
        log.info("publishing is paused; the post waits");
        return { next: new Date(now().getTime() + PUBLISHING_PAUSED_RETRY_MS) };
      }
      if (settled.kind === "rate_limited") {
        log.info({ retryAfterMs: settled.retryAfterMs }, "the channel is at its publishing limit");
        return { next: new Date(now().getTime() + settled.retryAfterMs) };
      }
      if (settled.kind === "done") {
        return;
      }

      const { started } = settled;
      const platform = started.inputs.channel.platform;
      const adapter = adapterFor(platform, started.dryRun);
      const built = contextFor(started, { signal, logger: log, now });
      let outcome: { ok: true; result: PublishResult } | { ok: false; error: PublishError };
      try {
        const issues = await adapter.validate(built.context);
        if (issues.length > 0) {
          throw PublishFailure.of(
            "invalid_media",
            issues.map((issue) => `${issue.field}: ${issue.message}`).join(" "),
            { retryable: false },
          );
        }
        outcome = { ok: true, result: await adapter.publish(built.context) };
      } catch (error) {
        if (signal.aborted) {
          throw error;
        }
        if (!(error instanceof PublishFailure)) {
          log.error({ err: error, platform }, "the adapter failed unexpectedly");
        }
        outcome = { ok: false, error: toPublishError(error) };
      }
      const retry = await record(started, outcome, built.recorded(), attempt, now(), log);
      if (retry !== null) {
        throw retry;
      }
    },
  );

  scheduler.register("post.check_status", async ({ payload, attempt, signal, logger, now }) => {
    const log = logger.child({ postId: payload.postId });
    const [post] = await db
      .select()
      .from(scheduledPosts)
      .where(eq(scheduledPosts.id, payload.postId));
    if (post === undefined || post.status !== "publishing") {
      return;
    }
    const [open] = await db
      .select()
      .from(publishAttempts)
      .where(eq(publishAttempts.postId, post.id))
      .orderBy(desc(publishAttempts.attempt))
      .limit(1);
    if (open === undefined || open.attempt !== post.attempts) {
      log.warn("a publishing post has no open attempt");
      return;
    }

    let inputs: PublishInputs;
    try {
      inputs = await loadInputs(db, post);
    } catch (error) {
      if (!(error instanceof PublishFailure)) {
        throw error;
      }
      await failIfCurrent(post.id, open, error.error, { request: null, response: null }, now());
      return;
    }
    const started: Started = { post, attempt: open, inputs, dryRun: open.dryRun };
    const adapter = adapterFor(inputs.channel.platform, open.dryRun);
    const built = contextFor(started, { signal, logger: log, now });
    const since = Date.parse(payload.since);

    let error: PublishError;
    try {
      const status = await adapter.status(built.context);
      const at = now();
      if (status.state === "published") {
        await transaction(db, async (tx) => {
          const current = await lockPost(tx, post.id);
          if (current?.status !== "publishing" || current.attempts !== open.attempt) {
            return;
          }
          await markPublished(
            tx,
            current,
            open.id,
            { permalink: status.permalink, externalId: status.externalId },
            built.recorded(),
            at,
            log,
          );
        });
        return;
      }
      if (status.state === "pending") {
        const elapsed = at.getTime() - since;
        if (elapsed < POST_STATUS_TIMEOUT_MS) {
          const next = Math.min(
            at.getTime() + statusPollDelayMs(elapsed),
            since + POST_STATUS_TIMEOUT_MS,
          );
          return { next: new Date(next) };
        }
        error = publishError(
          "transient",
          "The platform did not finish processing the post within 20 minutes.",
          { retryable: false },
        );
      } else {
        error =
          status.error ??
          publishError("permanent", "The platform could not publish the post.", {
            retryable: false,
          });
      }
    } catch (thrown) {
      if (signal.aborted) {
        throw thrown;
      }
      if (!(thrown instanceof PublishFailure)) {
        log.error({ err: thrown }, "the adapter status call failed unexpectedly");
      }
      error = toPublishError(thrown);
      if (error.retryable && attempt < maxStatusAttempts) {
        throw new TaskFailure(error.code, error.message, {
          retryable: true,
          retryAfterMs: error.retryAfterMs,
        });
      }
    }
    await failIfCurrent(post.id, open, error, built.recorded(), now());
  });

  async function failIfCurrent(
    postId: string,
    open: PublishAttemptRow,
    error: PublishError,
    recorded: RecordedExchange,
    now: Date,
  ): Promise<void> {
    await transaction(db, async (tx) => {
      const current = await lockPost(tx, postId);
      if (current?.status !== "publishing" || current.attempts !== open.attempt) {
        return;
      }
      await failPost(tx, current, error, { attemptId: open.id, recorded, now });
    });
  }
}
