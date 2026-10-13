import { z } from "zod";
import { type Platform, PlatformSchema } from "../enums";
import { CAPTION_MAX_LENGTH, MAX_TIMELINE_MS } from "../pipeline/artifacts";

// What the publisher hands a platform adapter, and how an adapter reports a failure. The dry-run
// adapter records the same request the live adapter would send.

export const PLATFORM_ACCOUNT_ID_MAX_LENGTH = 200;
export const MAX_VIDEO_DIMENSION = 8_192;
export const PUBLISH_ERROR_MESSAGE_MAX_LENGTH = 2_000;
export const PLATFORM_ERROR_CODE_MAX_LENGTH = 100;

/** A platform's id for an account, page or post, such as a Page id or an Instagram media id. */
export const PlatformAccountIdSchema = z.string().trim().min(1).max(PLATFORM_ACCOUNT_ID_MAX_LENGTH);

/**
 * One video to publish on one channel. `externalId` is the account the channel publishes as (the
 * Facebook Page, the Instagram professional account or the Threads profile). `videoUrl` and
 * `posterUrl` are public HTTPS links the platform fetches; they carry no credentials. Captions are
 * cut to each platform's limit by the publisher before they get here.
 */
export const PublishRequestSchema = z.object({
  platform: PlatformSchema,
  externalId: PlatformAccountIdSchema,
  videoUrl: z.url({ protocol: /^https$/ }),
  posterUrl: z.url({ protocol: /^https$/ }).optional(),
  caption: z.string().max(CAPTION_MAX_LENGTH),
  durationMs: z.number().int().min(1).max(MAX_TIMELINE_MS),
  width: z.number().int().min(1).max(MAX_VIDEO_DIMENSION),
  height: z.number().int().min(1).max(MAX_VIDEO_DIMENSION),
});
export type PublishRequest = z.infer<typeof PublishRequestSchema>;

/**
 * Why a publish failed:
 * - `rate_limited`: the platform asked us to slow down; see `retryAfterMs`.
 * - `auth`: the stored credentials are expired or revoked; the channel needs reconnecting.
 * - `permission`: the credentials lack a permission the request needs.
 * - `invalid_media`: the platform refused the video, poster or caption.
 * - `transient`: a timeout, a 5xx or a processing error worth retrying.
 * - `permanent`: anything else the platform will keep refusing.
 * - `not_configured`: no adapter or no connection for the platform, so nothing was sent.
 */
export const PUBLISH_ERROR_CODES = [
  "rate_limited",
  "auth",
  "permission",
  "invalid_media",
  "transient",
  "permanent",
  "not_configured",
] as const;
export const PublishErrorCodeSchema = z.enum(PUBLISH_ERROR_CODES);
export type PublishErrorCode = (typeof PUBLISH_ERROR_CODES)[number];

/** Codes that are retryable unless the adapter knows better. */
export const RETRYABLE_PUBLISH_ERROR_CODES = [
  "rate_limited",
  "transient",
] as const satisfies readonly PublishErrorCode[];

/**
 * A failed publish, stored on the post and its attempt. `retryable` decides whether the scheduler
 * tries again; `retryAfterMs` is the platform's own hint. `platformCode` is the platform's error
 * code (such as a Graph API code and subcode). `message` never contains credentials or URLs with
 * query strings.
 */
export const PublishErrorSchema = z.object({
  code: PublishErrorCodeSchema,
  retryable: z.boolean(),
  retryAfterMs: z.number().int().min(0).optional(),
  platformCode: z.string().min(1).max(PLATFORM_ERROR_CODE_MAX_LENGTH).optional(),
  message: z.string().max(PUBLISH_ERROR_MESSAGE_MAX_LENGTH),
});
export type PublishError = z.infer<typeof PublishErrorSchema>;

/** Permalinks of dry-run posts start with this scheme instead of `https://`. */
export const DRY_RUN_PERMALINK_SCHEME = "dryrun://";

/** The permalink the dry-run adapter records: `dryrun://<platform>/<postId>`. */
export function dryRunPermalink(platform: Platform, postId: string): string {
  return `${DRY_RUN_PERMALINK_SCHEME}${platform}/${postId}`;
}

/** A post's permalink: an HTTPS link on the platform, or a `dryrun://` link. */
export const PermalinkSchema = z
  .string()
  .max(2_048)
  .refine((value) => value.startsWith("https://") || value.startsWith(DRY_RUN_PERMALINK_SCHEME), {
    message: "Use an https:// or dryrun:// link",
  });
