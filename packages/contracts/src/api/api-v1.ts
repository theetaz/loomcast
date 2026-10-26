import { z } from "zod";
import { PostMetricsSchema } from "../analytics/metrics";
import { IdSchema, TimestampSchema } from "../common";
import {
  ApiChannelAccessSchema,
  AssetStatusSchema,
  ChannelStatusSchema,
  PlatformSchema,
  PostFormatSchema,
  PostStatusSchema,
} from "../enums";
import { CAPTION_MAX_LENGTH } from "../pipeline/artifacts";
import {
  ALT_TEXT_MAX_LENGTH,
  MAX_POST_MEDIA,
  MediaTypeSchema,
  PostOptionsSchema,
} from "../publishing/formats";
import { PublishErrorSchema } from "../publishing/request";
import { ASSET_KIND_MAX_BYTES, AssetFilenameSchema, Sha256HexSchema } from "./assets";
import { CursorPageQuerySchema } from "./common";
import { ContentTitleSchema } from "./content";

// The machine API (`/api/v1`): the owner's other backends schedule posts with an API key
// (`Authorization: Bearer lc_api_…`). A post is a content item of the client's workspace and one
// scheduled post per channel. The client declares its files, PUTs them to presigned URLs, then
// finalizes the post; a text post needs no files and is scheduled at once. `docs/api.md` is the
// guide.

/** Path prefix of the machine API. */
export const API_V1_PREFIX = "/api/v1";

/** Requests per API client: a burst of 120, refilling over a minute. */
export const API_V1_RATE_LIMIT = { capacity: 120, intervalMs: 60_000 } as const;

/** How long an `Idempotency-Key` is remembered. */
export const API_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

/** Most channels one post may go out on. */
export const API_POST_MAX_CHANNELS = 50;

export const API_EXTERNAL_REF_MAX_LENGTH = 200;

/** An `Idempotency-Key` header: 1 to 200 visible ASCII characters. */
export const IdempotencyKeySchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[\x21-\x7e]+$/, { message: "Use 1 to 200 visible ASCII characters" });

/** The MIME types a post's files may have. */
export const API_MEDIA_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "video/mp4",
  "video/quicktime",
] as const;
export const ApiMediaMimeSchema = z.enum(API_MEDIA_MIME_TYPES);

/** Largest width or height a file may declare, in pixels. */
export const API_MEDIA_MAX_DIMENSION = 16_384;

/**
 * One file of a new post, in order. The bytes are PUT afterwards to the upload URL. A video must
 * say how long it runs and its size in pixels, which the platforms check before they take it; a
 * photo may give its size, which Instagram checks (width and aspect ratio) when it is known.
 */
export const ApiMediaInputSchema = z
  .object({
    filename: AssetFilenameSchema,
    mime: ApiMediaMimeSchema,
    bytes: z.number().int().min(1).max(ASSET_KIND_MAX_BYTES.media),
    /** SHA-256 of the bytes as 64 hex characters; the upload and finalize check it. */
    sha256: Sha256HexSchema,
    width: z.number().int().min(1).max(API_MEDIA_MAX_DIMENSION).optional(),
    height: z.number().int().min(1).max(API_MEDIA_MAX_DIMENSION).optional(),
    /** Videos: how long it runs, in milliseconds. */
    durationMs: z.number().int().min(1).optional(),
    /** What a photo shows, for screen readers. */
    altText: z.string().trim().max(ALT_TEXT_MAX_LENGTH).optional(),
  })
  .strict()
  .superRefine((file, ctx) => {
    if (!file.mime.startsWith("video/")) {
      if (file.durationMs !== undefined) {
        ctx.addIssue({
          code: "custom",
          message: "Only videos have a duration",
          path: ["durationMs"],
        });
      }
      return;
    }
    for (const field of ["durationMs", "width", "height"] as const) {
      if (file[field] === undefined) {
        ctx.addIssue({ code: "custom", message: `A video needs its ${field}`, path: [field] });
      }
    }
  });
export type ApiMediaInput = z.infer<typeof ApiMediaInputSchema>;

/** One channel of a new post, with the post's per-platform options there. */
export const ApiPostChannelInputSchema = z
  .object({
    channelId: IdSchema,
    options: PostOptionsSchema.optional(),
  })
  .strict();
export type ApiPostChannelInput = z.infer<typeof ApiPostChannelInputSchema>;

/** `POST /api/v1/posts`. */
export const CreateApiPostRequestSchema = z
  .object({
    format: PostFormatSchema,
    /** Shown in Loomcast; defaults to the caption's first line. */
    title: ContentTitleSchema.optional(),
    caption: z.string().trim().max(CAPTION_MAX_LENGTH).optional(),
    media: z.array(ApiMediaInputSchema).max(MAX_POST_MEDIA).optional(),
    channels: z
      .array(ApiPostChannelInputSchema)
      .min(1)
      .max(API_POST_MAX_CHANNELS)
      .refine((list) => new Set(list.map((entry) => entry.channelId)).size === list.length, {
        message: "A channel may appear only once",
      }),
    scheduledAt: TimestampSchema,
    /** The client's own reference, returned as given. */
    externalRef: z.string().trim().min(1).max(API_EXTERNAL_REF_MAX_LENGTH).optional(),
  })
  .strict()
  .superRefine((post, ctx) => {
    const hashes = (post.media ?? []).map((entry) => entry.sha256);
    if (new Set(hashes).size !== hashes.length) {
      ctx.addIssue({ code: "custom", message: "The same file appears twice", path: ["media"] });
    }
  });
export type CreateApiPostRequest = z.infer<typeof CreateApiPostRequestSchema>;

/**
 * A post as the machine API shows it:
 * - `awaiting_media`: created; its files are not finalized yet.
 * - `pending_approval`: waiting in the owner's approvals.
 * - `scheduled`: approved and waiting for its time.
 * - `publishing`: going out on at least one channel.
 * - `published`: live (or recorded, in dry run) on every channel.
 * - `partially_published`: live on some channels, failed or missed on others.
 * - `failed`: no channel published it.
 * - `cancelled`: withdrawn.
 */
export const API_POST_STATUSES = [
  "awaiting_media",
  "pending_approval",
  "scheduled",
  "publishing",
  "published",
  "partially_published",
  "failed",
  "cancelled",
] as const;
export const ApiPostStatusSchema = z.enum(API_POST_STATUSES);
export type ApiPostStatus = (typeof API_POST_STATUSES)[number];

export const ApiPostMediaSchema = z.object({
  /** Null only when the upload could not be started; `POST /posts/:id/uploads` retries it. */
  mediaId: IdSchema.nullable(),
  type: MediaTypeSchema,
  altText: z.string().nullable(),
  status: AssetStatusSchema,
});
export type ApiPostMedia = z.infer<typeof ApiPostMediaSchema>;

/** The post on one channel. `postId` and `status` are null until the post is finalized. */
export const ApiPostTargetSchema = z.object({
  channelId: IdSchema,
  platform: PlatformSchema,
  postId: IdSchema.nullable(),
  status: PostStatusSchema.nullable(),
  scheduledAt: TimestampSchema,
  permalink: z.string().nullable(),
  externalId: z.string().nullable(),
  lastError: PublishErrorSchema.nullable(),
  publishedAt: TimestampSchema.nullable(),
  dryRun: z.boolean(),
});
export type ApiPostTarget = z.infer<typeof ApiPostTargetSchema>;

export const ApiPostSchema = z.object({
  /** The content item's id. */
  id: IdSchema,
  /** Only on posts this client created. */
  externalRef: z.string().nullable(),
  /** Whether this client created the post; only those can change. */
  own: z.boolean(),
  format: PostFormatSchema,
  title: z.string(),
  caption: z.string().nullable(),
  status: ApiPostStatusSchema,
  /** The earliest time of its open posts, or the requested time before it is finalized. */
  scheduledAt: TimestampSchema.nullable(),
  media: z.array(ApiPostMediaSchema),
  targets: z.array(ApiPostTargetSchema),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type ApiPost = z.infer<typeof ApiPostSchema>;

/** Where to PUT one file: send exactly `headers`, which the signature covers. */
export const ApiUploadSchema = z.object({
  mediaId: IdSchema,
  url: z.url(),
  method: z.literal("PUT"),
  headers: z.record(z.string(), z.string()),
  expiresAt: TimestampSchema,
});
export type ApiUpload = z.infer<typeof ApiUploadSchema>;

/** A created post, with an upload for each file that still needs its bytes, in media order. */
export const ApiPostWithUploadsSchema = ApiPostSchema.extend({
  uploads: z.array(ApiUploadSchema),
});
export type ApiPostWithUploads = z.infer<typeof ApiPostWithUploadsSchema>;

/** `GET /api/v1/posts`: the posts this client can see, newest first. */
export const ListApiPostsQuerySchema = CursorPageQuerySchema.extend({
  channelId: IdSchema.optional(),
  status: ApiPostStatusSchema.optional(),
  /** Posts whose `scheduledAt` is at or after this time. */
  from: TimestampSchema.optional(),
  /** Posts whose `scheduledAt` is before this time. */
  to: TimestampSchema.optional(),
}).strict();
export type ListApiPostsQuery = z.infer<typeof ListApiPostsQuerySchema>;

/** `PATCH /api/v1/posts/:id`: moves every open post of it to a new time. */
export const RescheduleApiPostRequestSchema = z.object({ scheduledAt: TimestampSchema }).strict();
export type RescheduleApiPostRequest = z.infer<typeof RescheduleApiPostRequestSchema>;

/** `POST /api/v1/posts/:id/finalize` takes no fields. */
export const FinalizeApiPostRequestSchema = z.object({}).strict();

export const ApiV1GrantSchema = z.object({
  channelId: IdSchema,
  access: ApiChannelAccessSchema,
});

/** `GET /api/v1/me`: the client behind the key. */
export const ApiV1MeSchema = z.object({
  client: z.object({
    id: IdSchema,
    name: z.string(),
    prefix: z.string(),
    createdAt: TimestampSchema,
    expiresAt: TimestampSchema.nullable(),
  }),
  workspace: z.object({ id: IdSchema, slug: z.string(), name: z.string() }),
  /** Deprecated: the same as `workspace`, for clients written when workspaces were projects. */
  project: z.object({ id: IdSchema, slug: z.string(), name: z.string() }),
  grants: z.array(ApiV1GrantSchema),
  rateLimit: z.object({ requests: z.number().int(), perSeconds: z.number().int() }),
});
export type ApiV1Me = z.infer<typeof ApiV1MeSchema>;

/** One granted channel. */
export const ApiV1ChannelSchema = z.object({
  id: IdSchema,
  platform: PlatformSchema,
  name: z.string(),
  username: z.string().nullable(),
  status: ChannelStatusSchema,
  /** While on, posts are only recorded, never sent (`dryrun://` permalinks). */
  dryRun: z.boolean(),
  /** Every post here waits for the owner's approval, whatever the client's access. */
  requiresApproval: z.boolean(),
  access: ApiChannelAccessSchema,
  /** The formats this channel's platform publishes. */
  formats: z.array(PostFormatSchema),
});
export type ApiV1Channel = z.infer<typeof ApiV1ChannelSchema>;

/** `GET /api/v1/posts/:id/metrics`: the latest capture per published target. */
export const ApiPostMetricsSchema = z.object({
  id: IdSchema,
  targets: z.array(
    z.object({
      channelId: IdSchema,
      platform: PlatformSchema,
      postId: IdSchema,
      metrics: PostMetricsSchema.nullable(),
    }),
  ),
});
export type ApiPostMetrics = z.infer<typeof ApiPostMetricsSchema>;
