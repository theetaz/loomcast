import {
  type ApiError,
  type Channel,
  CreateChannelRequestSchema,
  routes,
  type SeriesChannelLink,
  UpdateChannelRequestSchema,
  UpdateSeriesChannelsRequestSchema,
} from "@loomcast/contracts";
import { HttpResponse, http } from "msw";
import type { z } from "zod";
import { channelView, mockChannel, mockPublisher } from "./calendar";
import { type MockDb, publish } from "./db";

// Channel settings and the publisher's switches, following the channels and publisher modules of
// the API: planning channels, the dry-run and approval switches (`409 dry_run_locked` with the
// blocker in `details.reason`), the channels of a series and `GET /api/publisher/status`.
// Channels belong to a workspace; `channels.list` is served with the calendar mocks.

const path = (name: keyof typeof routes) => `*${routes[name].path}`;

function apiError(status: number, code: string, message: string, details?: unknown) {
  return HttpResponse.json<ApiError>(
    { error: { code, message, ...(details === undefined ? {} : { details }) } },
    { status },
  );
}

const unauthorized = () => apiError(401, "unauthorized", "Sign in to continue.");
const channelNotFound = () => apiError(404, "not_found", "No channel has that id.");

function invalid(error: z.ZodError) {
  return apiError(
    400,
    "validation_failed",
    "The request is not valid.",
    error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
  );
}

function touch(channel: Channel) {
  channel.updatedAt = new Date(
    Math.max(Date.now(), Date.parse(channel.updatedAt) + 1),
  ).toISOString();
}

/** Publishes `channel.updated` with the channel as the API shows it, and returns that copy. */
function emitChannel(db: MockDb, channel: Channel): Channel {
  const view = channelView(db, channel);
  publish(db, { type: "channel.updated", payload: { channel: view } });
  return view;
}

export function createChannelHandlers(db: MockDb) {
  return [
    http.post(path("channels.create"), async ({ params, request }) => {
      if (!db.signedIn) return unauthorized();
      const workspace = db.workspaces.find((entry) => entry.id === params.workspaceId);
      if (!workspace) return apiError(404, "not_found", "No workspace has that id.");
      const parsed = CreateChannelRequestSchema.safeParse(await request.json().catch(() => null));
      if (!parsed.success) return invalid(parsed.error);
      const channel = mockChannel({
        workspaceId: workspace.id,
        platform: parsed.data.platform,
        displayName: parsed.data.displayName,
        requiresApproval: parsed.data.requiresApproval ?? false,
      });
      db.channels.push(channel);
      return HttpResponse.json(emitChannel(db, channel), { status: 201 });
    }),

    http.patch(path("channels.update"), async ({ params, request }) => {
      if (!db.signedIn) return unauthorized();
      const channel = db.channels.find((entry) => entry.id === params.id);
      if (!channel) return channelNotFound();
      const parsed = UpdateChannelRequestSchema.safeParse(await request.json().catch(() => null));
      if (!parsed.success) return invalid(parsed.error);
      const change = parsed.data;
      const current = channelView(db, channel);
      if (change.dryRun === false && current.dryRun && current.liveBlocker !== null) {
        return apiError(409, "dry_run_locked", "This channel cannot leave dry-run yet.", {
          reason: current.liveBlocker,
        });
      }
      let changed = false;
      if (change.displayName !== undefined && change.displayName !== channel.displayName) {
        channel.displayName = change.displayName;
        changed = true;
      }
      if (change.dryRun !== undefined && change.dryRun !== channel.dryRun) {
        channel.dryRun = change.dryRun;
        changed = true;
      }
      if (
        change.requiresApproval !== undefined &&
        change.requiresApproval !== channel.requiresApproval
      ) {
        channel.requiresApproval = change.requiresApproval;
        changed = true;
      }
      if (!changed) return HttpResponse.json(current);
      touch(channel);
      return HttpResponse.json(emitChannel(db, channel));
    }),

    http.get(path("series.channels"), ({ params }) => {
      if (!db.signedIn) return unauthorized();
      const series = db.series.find((entry) => entry.id === params.id);
      if (!series) return apiError(404, "not_found", "No series has that id.");
      const links = db.seriesChannels.find((entry) => entry.seriesId === series.id);
      return HttpResponse.json({
        seriesId: series.id,
        channels: (links?.channels ?? []).map((link) => ({ ...link })),
      });
    }),

    http.put(path("series.setChannels"), async ({ params, request }) => {
      if (!db.signedIn) return unauthorized();
      const series = db.series.find((entry) => entry.id === params.id);
      if (!series) return apiError(404, "not_found", "No series has that id.");
      const parsed = UpdateSeriesChannelsRequestSchema.safeParse(
        await request.json().catch(() => null),
      );
      if (!parsed.success) return invalid(parsed.error);
      if (series.status === "archived") {
        return apiError(409, "conflict", "The series is archived.", {
          reason: "archived_series",
        });
      }
      const input = parsed.data.channels;
      const unknown = input.flatMap((link, index) =>
        db.channels.some((channel) => channel.id === link.channelId)
          ? []
          : [{ path: `channels.${index}.channelId`, message: "No channel has that id" }],
      );
      if (unknown.length > 0) {
        return apiError(400, "validation_failed", "The request is not valid.", unknown);
      }
      const disabled = input.find(
        (link) =>
          link.enabled &&
          db.channels.find((channel) => channel.id === link.channelId)?.status === "disabled",
      );
      if (disabled) {
        return apiError(409, "conflict", "A disabled channel cannot be linked as enabled.", {
          reason: "channel_disabled",
          channelId: disabled.channelId,
        });
      }
      let entry = db.seriesChannels.find((links) => links.seriesId === series.id);
      if (!entry) {
        entry = { seriesId: series.id, channels: [] };
        db.seriesChannels.push(entry);
      }
      // Kept links keep their place (the API orders by when a link was made); new ones go last.
      const byId = new Map(input.map((link) => [link.channelId, link]));
      const kept: SeriesChannelLink[] = entry.channels.flatMap((link) => {
        const next = byId.get(link.channelId);
        return next ? [{ ...next }] : [];
      });
      const added = input.filter(
        (link) => !entry.channels.some((existing) => existing.channelId === link.channelId),
      );
      entry.channels = [...kept, ...added.map((link) => ({ ...link }))];
      return HttpResponse.json({
        seriesId: series.id,
        channels: entry.channels.map((link) => ({ ...link })),
      });
    }),

    http.get(path("publisher.status"), () =>
      db.signedIn ? HttpResponse.json(mockPublisher(db)) : unauthorized(),
    ),
  ];
}
