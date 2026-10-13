import { z } from "zod";
import { IdSchema, TimestampSchema } from "../common";
import { ChannelStatusSchema, PlatformSchema } from "../enums";

export const CHANNEL_NAME_MAX_LENGTH = 120;
export const CHANNEL_USERNAME_MAX_LENGTH = 200;
export const CHANNEL_SCOPE_MAX_LENGTH = 200;
/** Most channels one series can be linked to. */
export const MAX_SERIES_CHANNELS = 50;

export const ChannelNameSchema = z.string().trim().min(1).max(CHANNEL_NAME_MAX_LENGTH);

/**
 * Why a channel cannot leave dry-run, as the server decides it:
 * - `not_connected`: no stored credentials (a planning channel).
 * - `not_active`: the channel needs reconnecting or is disabled.
 * - `publishing_dry_run`: the server's `PUBLISHING_MODE` is `dry-run`.
 * - `platform_unavailable`: live publishing to the platform is not available, such as X behind its
 *   feature flag.
 */
export const LIVE_PUBLISHING_BLOCKERS = [
  "not_connected",
  "not_active",
  "publishing_dry_run",
  "platform_unavailable",
] as const;
export const LivePublishingBlockerSchema = z.enum(LIVE_PUBLISHING_BLOCKERS);
export type LivePublishingBlocker = (typeof LIVE_PUBLISHING_BLOCKERS)[number];

/**
 * An account a series can publish to. It never carries credentials: tokens stay encrypted on the
 * server, and parsing a row through this schema drops every field it does not list.
 */
export const ChannelSchema = z.object({
  id: IdSchema,
  platform: PlatformSchema,
  displayName: z.string(),
  /** The platform's id of the Page, professional account or profile; null until connected. */
  externalId: z.string().nullable(),
  /** The account's handle on the platform, when it has one. */
  username: z.string().nullable(),
  /** The channel this one was connected through, such as an Instagram account's Facebook Page. */
  parentChannelId: IdSchema.nullable(),
  status: ChannelStatusSchema,
  /** On by default. While on, the publisher only records what it would send. */
  dryRun: z.boolean(),
  /** Every post on this channel waits for a person's approval, whatever the series' mode. */
  requiresApproval: z.boolean(),
  /** Whether credentials are stored. */
  connected: z.boolean(),
  /** Permissions the stored credentials were granted. */
  scopes: z.array(z.string().max(CHANNEL_SCOPE_MAX_LENGTH)),
  tokenExpiresAt: TimestampSchema.nullable(),
  /** Why `dryRun` cannot be switched off right now; null when it can. */
  liveBlocker: LivePublishingBlockerSchema.nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  disabledAt: TimestampSchema.nullable(),
});
export type Channel = z.infer<typeof ChannelSchema>;

/**
 * Adds a planning channel: no credentials, status `disconnected`, dry-run on. Connecting it to the
 * platform comes later (M5).
 */
export const CreateChannelRequestSchema = z.object({
  platform: PlatformSchema,
  displayName: ChannelNameSchema,
  requiresApproval: z.boolean().optional(),
});
export type CreateChannelRequest = z.infer<typeof CreateChannelRequestSchema>;

/**
 * Partial update. Switching `dryRun` off answers `409 dry_run_locked` (with the blocker in
 * `details.reason`) unless the channel is active and connected and the server publishes live.
 */
export const UpdateChannelRequestSchema = z
  .object({
    displayName: ChannelNameSchema.optional(),
    dryRun: z.boolean().optional(),
    requiresApproval: z.boolean().optional(),
  })
  .refine(
    (update) =>
      update.displayName !== undefined ||
      update.dryRun !== undefined ||
      update.requiresApproval !== undefined,
    { message: "Provide at least one field to update" },
  );
export type UpdateChannelRequest = z.infer<typeof UpdateChannelRequestSchema>;

/** One channel of a series. A disabled link keeps its posts but plans no new ones. */
export const SeriesChannelLinkSchema = z.object({
  channelId: IdSchema,
  enabled: z.boolean(),
});
export type SeriesChannelLink = z.infer<typeof SeriesChannelLinkSchema>;

const SeriesChannelLinksSchema = z
  .array(SeriesChannelLinkSchema)
  .max(MAX_SERIES_CHANNELS)
  .refine((links) => new Set(links.map((link) => link.channelId)).size === links.length, {
    message: "A channel must not repeat",
  });

/** The channels a series publishes to. */
export const SeriesChannelsSchema = z.object({
  seriesId: IdSchema,
  channels: SeriesChannelLinksSchema,
});
export type SeriesChannels = z.infer<typeof SeriesChannelsSchema>;

/** Replaces the whole set: channels left out are unlinked. */
export const UpdateSeriesChannelsRequestSchema = z.object({
  channels: SeriesChannelLinksSchema,
});
export type UpdateSeriesChannelsRequest = z.infer<typeof UpdateSeriesChannelsRequestSchema>;
