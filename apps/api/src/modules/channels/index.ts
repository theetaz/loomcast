import {
  type Channel,
  CreateChannelRequestSchema,
  type JsonObject,
  routes,
  type SeriesChannels,
  UpdateChannelRequestSchema,
  UpdateSeriesChannelsRequestSchema,
} from "@loomcast/contracts";
import { channels, series, seriesChannels } from "@loomcast/db";
import { and, asc, eq, inArray, notInArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import type { ModuleDeps } from "../../deps";
import { audit } from "../../lib/audit";
import { afterCommit, type Executor, type Transaction, transaction } from "../../lib/db";
import { conflict, forbidden, HttpError, notFound, validationFailed } from "../../lib/errors";
import { clientIp, idParam, readJson } from "../../lib/http";
import type { AppEnv } from "../../types";
import { currentUser } from "../auth/guards";
import { isLivePlatformAvailable } from "../publisher/adapters";
import { channelColumns, toChannel } from "./mappers";
import { ensureChannelSweeps, registerRefreshTask } from "./tasks";
import { registerVerifyTask } from "./verify";

export { type ChannelView, channelColumns, toChannel } from "./mappers";
export { channelSweepDedupeKey, ensureChannelSweeps } from "./tasks";

/** Dedupe key of the replanning a change of a series' channels asks for. */
export function seriesPlanDedupeKey(seriesId: string): string {
  return `plan:${seriesId}`;
}

const channelNotFound = () => notFound("No channel has that id.");
const seriesNotFound = () => notFound("No series has that id.");

/**
 * Channel endpoints: list channels, add a planning channel (`403 forbidden` for X while X
 * publishing is not usable), update one (name, approval, dry-run switch), and the channels of a
 * series. Switching dry-run off answers `409 dry_run_locked` with
 * the blocker in `details.reason` unless the channel is active and connected, its platform can
 * publish live, and the server's `PUBLISHING_MODE` is `live`. Every change is audited and
 * published as `channel.updated`. Credentials never leave the server: responses are built from
 * columns that exclude them. Channels are connected through the sign-ins of the oauth module;
 * `channels.disconnect` wipes a channel's credentials.
 */
export function register(app: Hono<AppEnv>, deps: ModuleDeps): Hono<AppEnv> {
  const { db, bus, scheduler } = deps;
  const trustProxy = deps.config.trustProxy;
  const router = new Hono<AppEnv>();

  registerRefreshTask(deps);
  registerVerifyTask(deps);
  // A served process makes sure the daily credential sweeps are queued (they re-queue themselves).
  if (deps.httpServer !== undefined && deps.config.scheduler.enabled) {
    ensureChannelSweeps(scheduler, null, deps.clock.now()).catch((error: unknown) => {
      deps.logger.error({ err: error }, "could not queue the channel credential sweeps");
    });
  }

  async function loadChannel(
    executor: Executor,
    id: string,
    lock = false,
  ): Promise<Channel | null> {
    const query = executor.select(channelColumns).from(channels).where(eq(channels.id, id));
    const [row] = lock ? await query.for("update", { of: channels }) : await query;
    return row === undefined ? null : toChannel(row, deps.config);
  }

  function emitChannel(tx: Transaction, channel: Channel): void {
    afterCommit(tx, () => bus.publish({ type: "channel.updated", payload: { channel } }));
  }

  router.get(routes["channels.list"].path, async (c) => {
    currentUser(c);
    const rows = await db
      .select(channelColumns)
      .from(channels)
      .orderBy(asc(channels.platform), asc(channels.displayName), asc(channels.createdAt));
    c.header("Cache-Control", "no-store");
    return c.json({ items: rows.map((row) => toChannel(row, deps.config)) }, 200);
  });

  router.post(routes["channels.create"].path, async (c) => {
    const user = currentUser(c);
    const input = await readJson(c, CreateChannelRequestSchema);
    // X channels exist only while X publishing is usable (`FEATURE_X_PUBLISHING` on, client set).
    if (!isLivePlatformAvailable(input.platform, deps.config.platforms)) {
      throw forbidden("X publishing is turned off on this server.");
    }
    const channel = await transaction(db, async (tx) => {
      const [row] = await tx
        .insert(channels)
        .values({
          platform: input.platform,
          displayName: input.displayName,
          requiresApproval: input.requiresApproval ?? false,
          createdBy: user.id,
        })
        .returning({ id: channels.id });
      if (row === undefined) {
        throw new Error("the channel was not inserted");
      }
      const created = await loadChannel(tx, row.id);
      if (created === null) {
        throw new Error("the channel vanished");
      }
      await audit(tx, {
        actorKind: "user",
        actorId: user.id,
        action: "channel.created",
        targetType: "channel",
        targetId: created.id,
        data: {
          platform: created.platform,
          displayName: created.displayName,
          requiresApproval: created.requiresApproval,
        },
        ip: clientIp(c, trustProxy),
      });
      emitChannel(tx, created);
      return created;
    });
    return c.json(channel, 201);
  });

  router.patch(routes["channels.update"].path, async (c) => {
    const user = currentUser(c);
    const id = idParam(c);
    const input = await readJson(c, UpdateChannelRequestSchema);
    const channel = await transaction(db, async (tx) => {
      const current = await loadChannel(tx, id, true);
      if (current === null) {
        throw channelNotFound();
      }
      if (input.dryRun === false && current.dryRun && current.liveBlocker !== null) {
        throw new HttpError(409, "dry_run_locked", "This channel cannot leave dry-run yet.", {
          reason: current.liveBlocker,
        });
      }
      const changes: Record<string, JsonObject> = {};
      const set: Partial<typeof channels.$inferInsert> = {};
      if (input.displayName !== undefined && input.displayName !== current.displayName) {
        set.displayName = input.displayName;
        changes.displayName = { from: current.displayName, to: input.displayName };
      }
      if (input.dryRun !== undefined && input.dryRun !== current.dryRun) {
        set.dryRun = input.dryRun;
        changes.dryRun = { from: current.dryRun, to: input.dryRun };
      }
      if (
        input.requiresApproval !== undefined &&
        input.requiresApproval !== current.requiresApproval
      ) {
        set.requiresApproval = input.requiresApproval;
        changes.requiresApproval = { from: current.requiresApproval, to: input.requiresApproval };
      }
      if (Object.keys(changes).length === 0) {
        return current;
      }
      await tx
        .update(channels)
        .set({ ...set, updatedAt: sql`now()` })
        .where(eq(channels.id, id));
      const updated = await loadChannel(tx, id);
      if (updated === null) {
        throw new Error("the channel vanished");
      }
      await audit(tx, {
        actorKind: "user",
        actorId: user.id,
        action: "channel.updated",
        targetType: "channel",
        targetId: id,
        data: { changes },
        ip: clientIp(c, trustProxy),
      });
      emitChannel(tx, updated);
      return updated;
    });
    return c.json(channel, 200);
  });

  router.delete(routes["channels.disconnect"].path, async (c) => {
    const user = currentUser(c);
    const id = idParam(c);
    const channel = await transaction(db, async (tx) => {
      const current = await loadChannel(tx, id, true);
      if (current === null) {
        throw channelNotFound();
      }
      // The credentials go; the channel, its account id, series links and posts stay, so a later
      // sign-in with the same account reconnects this channel.
      await tx
        .update(channels)
        .set({
          secretCiphertext: null,
          secretNonce: null,
          keyVersion: null,
          status: current.status === "disabled" ? "disabled" : "disconnected",
          dryRun: true,
          scopes: [],
          tokenExpiresAt: null,
          lastVerifiedAt: null,
          lastError: null,
          updatedAt: sql`now()`,
        })
        .where(eq(channels.id, id));
      const updated = await loadChannel(tx, id);
      if (updated === null) {
        throw new Error("the channel vanished");
      }
      await audit(tx, {
        actorKind: "user",
        actorId: user.id,
        action: "channel.disconnected",
        targetType: "channel",
        targetId: id,
        data: { platform: current.platform, wasConnected: current.connected },
        ip: clientIp(c, trustProxy),
      });
      emitChannel(tx, updated);
      return updated;
    });
    return c.json(channel, 200);
  });

  async function seriesChannelsOf(executor: Executor, seriesId: string): Promise<SeriesChannels> {
    const links = await executor
      .select({ channelId: seriesChannels.channelId, enabled: seriesChannels.enabled })
      .from(seriesChannels)
      .where(eq(seriesChannels.seriesId, seriesId))
      .orderBy(asc(seriesChannels.createdAt), asc(seriesChannels.channelId));
    return { seriesId, channels: links };
  }

  router.get(routes["series.channels"].path, async (c) => {
    currentUser(c);
    const id = idParam(c);
    const [found] = await db.select({ id: series.id }).from(series).where(eq(series.id, id));
    if (found === undefined) {
      throw seriesNotFound();
    }
    return c.json(await seriesChannelsOf(db, id), 200);
  });

  router.put(routes["series.setChannels"].path, async (c) => {
    const user = currentUser(c);
    const id = idParam(c);
    const input = await readJson(c, UpdateSeriesChannelsRequestSchema);
    const result = await transaction(db, async (tx) => {
      const [row] = await tx
        .select({ id: series.id, status: series.status, projectId: series.projectId })
        .from(series)
        .where(eq(series.id, id))
        .for("update");
      if (row === undefined) {
        throw seriesNotFound();
      }
      if (row.status === "archived") {
        throw conflict("The series is archived.", { reason: "archived_series" });
      }
      const ids = input.channels.map((link) => link.channelId);
      const known =
        ids.length === 0
          ? []
          : await tx
              .select({ id: channels.id, status: channels.status })
              .from(channels)
              .where(inArray(channels.id, ids))
              .for("share");
      const statusById = new Map(known.map((channel) => [channel.id, channel.status]));
      const unknown = input.channels.flatMap((link, index) =>
        statusById.has(link.channelId)
          ? []
          : [{ path: `channels.${index}.channelId`, message: "No channel has that id" }],
      );
      if (unknown.length > 0) {
        throw validationFailed(unknown);
      }
      const disabled = input.channels.find(
        (link) => link.enabled && statusById.get(link.channelId) === "disabled",
      );
      if (disabled !== undefined) {
        throw conflict("A disabled channel cannot be linked as enabled.", {
          reason: "channel_disabled",
          channelId: disabled.channelId,
        });
      }

      const before = await seriesChannelsOf(tx, id);
      await tx
        .delete(seriesChannels)
        .where(
          ids.length === 0
            ? eq(seriesChannels.seriesId, id)
            : and(eq(seriesChannels.seriesId, id), notInArray(seriesChannels.channelId, ids)),
        );
      if (input.channels.length > 0) {
        await tx
          .insert(seriesChannels)
          .values(
            input.channels.map((link) => ({
              seriesId: id,
              channelId: link.channelId,
              enabled: link.enabled,
            })),
          )
          .onConflictDoUpdate({
            target: [seriesChannels.seriesId, seriesChannels.channelId],
            set: { enabled: sql`excluded.enabled` },
          });
      }
      const after = await seriesChannelsOf(tx, id);
      await audit(tx, {
        actorKind: "user",
        actorId: user.id,
        action: "series.channels.updated",
        targetType: "series",
        targetId: id,
        data: { projectId: row.projectId, before: before.channels, after: after.channels },
        ip: clientIp(c, trustProxy),
      });
      // Replan the series' slots on its new channels, once the calendar plans them.
      if (scheduler.hasHandler("cadence.plan")) {
        await scheduler.enqueue(
          tx,
          "cadence.plan",
          { seriesId: id },
          { dedupeKey: seriesPlanDedupeKey(id) },
        );
      }
      return after;
    });
    return c.json(result, 200);
  });

  app.route("/", router);
  return router;
}
