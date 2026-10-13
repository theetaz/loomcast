import { z } from "zod";
import { IdSchema, TimestampSchema } from "../common";
import { type AssetKind, AssetKindSchema, AssetStatusSchema } from "../enums";
import { VoiceAlignmentSchema } from "../pipeline/artifacts";
import { isPlainText } from "./kb";

// Stored files: voice takes, renders, posters, frames and reference media. Bytes never pass
// through the API: a client asks for an upload, PUTs the file to the presigned URL, then
// finalizes the asset, which verifies its size and SHA-256.

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

/** MIME types each asset kind accepts. */
export const ASSET_KIND_MIME_TYPES = {
  voice: ["audio/mpeg", "audio/wav", "audio/x-wav", "audio/mp4", "audio/x-m4a"],
  render: ["video/mp4"],
  poster: ["image/jpeg", "image/png", "image/webp"],
  frame: ["image/jpeg", "image/png", "image/webp"],
  reference_media: [
    "video/mp4",
    "video/quicktime",
    "audio/mpeg",
    "audio/wav",
    "audio/x-wav",
    "audio/mp4",
    "audio/x-m4a",
  ],
  other: ["text/plain", "image/jpeg", "image/png", "image/webp"],
} as const satisfies Record<AssetKind, readonly string[]>;

/** Every MIME type an asset may have. */
export const ASSET_MIME_TYPES = [
  "video/mp4",
  "video/quicktime",
  "audio/mpeg",
  "audio/wav",
  "audio/x-wav",
  "audio/mp4",
  "audio/x-m4a",
  "image/jpeg",
  "image/png",
  "image/webp",
  "text/plain",
] as const;
export const AssetMimeTypeSchema = z.enum(ASSET_MIME_TYPES);
export type AssetMimeType = (typeof ASSET_MIME_TYPES)[number];

/** Largest upload per asset kind, in bytes. */
export const ASSET_KIND_MAX_BYTES = {
  voice: 100 * MiB,
  render: GiB,
  poster: 20 * MiB,
  frame: 20 * MiB,
  reference_media: GiB,
  other: 20 * MiB,
} as const satisfies Record<AssetKind, number>;

export const ASSET_FILENAME_MAX_LENGTH = 255;

/** Whether `mime` is allowed for assets of `kind`. */
export function isAssetMimeTypeFor(kind: AssetKind, mime: string): boolean {
  return (ASSET_KIND_MIME_TYPES[kind] as readonly string[]).includes(mime);
}

/** A SHA-256 digest as 64 hex characters; stored lowercase. */
export const Sha256HexSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-f0-9]{64}$/, { message: "Use the SHA-256 digest as 64 hex characters" });

/** A file name without directories, used for downloads. */
export const AssetFilenameSchema = z
  .string()
  .trim()
  .min(1)
  .max(ASSET_FILENAME_MAX_LENGTH)
  .refine((name) => !/[/\\]/.test(name) && name !== "." && name !== ".." && isPlainText(name), {
    message: "Use a file name without folders or control characters",
  });

/** Media facts the studio agent measured with ffprobe, sent when it finalizes an upload. */
export const AssetProbeSchema = z.object({
  durationMs: z.number().int().min(0).optional(),
  width: z.number().int().min(1).max(16_384).optional(),
  height: z.number().int().min(1).max(16_384).optional(),
  fps: z.number().min(0).max(1_000).optional(),
  videoCodec: z.string().max(64).optional(),
  audioCodec: z.string().max(64).optional(),
  bitRate: z.number().int().min(0).optional(),
  sampleRate: z.number().int().min(0).optional(),
  channels: z.number().int().min(0).max(64).optional(),
  formatName: z.string().max(128).optional(),
});
export type AssetProbe = z.infer<typeof AssetProbeSchema>;

/** An asset as listed and sent in live events. The storage location is never exposed. */
export const AssetSchema = z.object({
  id: IdSchema,
  projectId: IdSchema,
  /** The content item it belongs to; null for project-level media such as references. */
  itemId: IdSchema.nullable(),
  kind: AssetKindSchema,
  status: AssetStatusSchema,
  filename: z.string(),
  mime: z.string(),
  bytes: z.number().int().min(0),
  sha256: z.string(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  durationMs: z.number().int().nullable(),
  probe: AssetProbeSchema.nullable(),
  createdAt: TimestampSchema,
  finalizedAt: TimestampSchema.nullable(),
});
export type Asset = z.infer<typeof AssetSchema>;

/** One asset with everything about it. `alignment` holds a voice take's word timings. */
export const AssetDetailSchema = AssetSchema.extend({
  alignment: VoiceAlignmentSchema.nullable(),
});
export type AssetDetail = z.infer<typeof AssetDetailSchema>;

/**
 * Asks for an upload. The MIME type must suit the kind (`ASSET_KIND_MIME_TYPES`) and the size its
 * cap (`ASSET_KIND_MAX_BYTES`). `itemId` must belong to `projectId`.
 */
export const CreateUploadRequestSchema = z
  .object({
    projectId: IdSchema,
    itemId: IdSchema.optional(),
    kind: AssetKindSchema,
    filename: AssetFilenameSchema,
    mime: AssetMimeTypeSchema,
    bytes: z.number().int().min(1),
    sha256: Sha256HexSchema,
  })
  .superRefine((upload, ctx) => {
    if (!isAssetMimeTypeFor(upload.kind, upload.mime)) {
      ctx.addIssue({
        code: "custom",
        message: `A ${upload.kind} asset cannot be ${upload.mime}`,
        path: ["mime"],
      });
    }
    if (upload.bytes > ASSET_KIND_MAX_BYTES[upload.kind]) {
      ctx.addIssue({
        code: "custom",
        message: `A ${upload.kind} asset is at most ${ASSET_KIND_MAX_BYTES[upload.kind]} bytes`,
        path: ["bytes"],
      });
    }
  });
export type CreateUploadRequest = z.infer<typeof CreateUploadRequestSchema>;

/**
 * Where and how to PUT the bytes. Send exactly `headers` (they include the content type and the
 * SHA-256 checksum the store verifies) before `expiresAt`.
 */
export const UploadInstructionsSchema = z.object({
  url: z.url({ protocol: /^https?$/ }),
  method: z.literal("PUT"),
  headers: z.record(z.string(), z.string()),
  expiresAt: TimestampSchema,
});
export type UploadInstructions = z.infer<typeof UploadInstructionsSchema>;

/**
 * The asset and its upload. When the project already has a ready asset of the same kind and
 * SHA-256, that asset is returned with `upload: null` and nothing needs uploading.
 */
export const CreateUploadResponseSchema = z.object({
  asset: AssetSchema,
  upload: UploadInstructionsSchema.nullable(),
});
export type CreateUploadResponse = z.infer<typeof CreateUploadResponseSchema>;

/**
 * Finalizes an upload: the server checks the stored size and SHA-256, marks the asset `ready` (or
 * `failed` and deletes the object) and stores the probe. `alignment` is accepted for voice takes
 * only.
 */
export const FinalizeAssetRequestSchema = z.object({
  probe: AssetProbeSchema.optional(),
  alignment: VoiceAlignmentSchema.optional(),
});
export type FinalizeAssetRequest = z.infer<typeof FinalizeAssetRequestSchema>;

/** `attachment` makes browsers download the file under its `filename`. */
export const AssetUrlQuerySchema = z.object({
  disposition: z.enum(["inline", "attachment"]).optional(),
});
export type AssetUrlQuery = z.infer<typeof AssetUrlQuerySchema>;

/** A presigned GET URL. Refresh it before `expiresAt`. */
export const AssetUrlSchema = z.object({
  url: z.url({ protocol: /^https?$/ }),
  expiresAt: TimestampSchema,
});
export type AssetUrl = z.infer<typeof AssetUrlSchema>;

/** `GET /api/content/:id/assets`: an item's assets, newest first, optionally of one kind. */
export const ListItemAssetsQuerySchema = z.object({
  kind: AssetKindSchema.optional(),
});
export type ListItemAssetsQuery = z.infer<typeof ListItemAssetsQuerySchema>;
