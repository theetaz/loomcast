import { z } from "zod";
import { IdSchema } from "../common";

/** Error codes the API uses. `ApiError.error.code` stays an open string so clients tolerate new codes. */
export const API_ERROR_CODES = [
  "bad_request",
  "validation_failed",
  "unauthorized",
  "forbidden",
  "not_found",
  "conflict",
  "rate_limited",
  "internal",
  /** The pipeline state machine refuses the change (409). */
  "invalid_transition",
  /** The item already has a production job queued or running (409). */
  "job_in_progress",
  /** The action needs an artifact the current version lacks, such as a voice before a render (422). */
  "missing_artifact",
  /** The `voice` step needs a `voiceId` in the format rules (422). */
  "voice_not_configured",
  /** The channel cannot leave dry-run; `details.reason` is a `LivePublishingBlocker` (409). */
  "dry_run_locked",
  /** The post is publishing, published or cancelled and cannot change (409). */
  "post_not_editable",
  /** The pending channel connection expired or was already accepted (410). */
  "connection_expired",
  /** The channel's platform does not publish the post's format (422). */
  "format_not_supported",
  /** The `Idempotency-Key` was used before with a different request body (409). */
  "idempotency_conflict",
  /** A file's bytes are not what its declared MIME type says (422). */
  "media_type_mismatch",
  /** A file has not been uploaded yet, or failed verification (409). */
  "upload_missing",
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

/** Body of every non-2xx JSON response. */
export const ApiErrorSchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 100;

/**
 * Query string of a cursor-paginated list. `cursor` is opaque to clients: pass back the
 * `nextCursor` of the previous page. Query values arrive as strings, so `limit` is coerced.
 */
export const CursorPageQuerySchema = z.object({
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).optional(),
});
export type CursorPageQuery = z.infer<typeof CursorPageQuerySchema>;

/** A page of a cursor-paginated list. `nextCursor` is null on the last page. */
export function cursorPageSchema<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    nextCursor: z.string().nullable(),
  });
}
export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
}

/**
 * A list of enum values in a query string: comma-separated (`states=idea,script`) or repeated
 * values, already split into an array. Values must not repeat.
 */
export function csvEnumQuerySchema<const T extends readonly [string, ...string[]]>(values: T) {
  const item = z.enum(values);
  const list = z
    .array(item)
    .min(1)
    .max(values.length)
    .refine((items) => new Set(items).size === items.length, { message: "Values must not repeat" });
  return z.union([
    list,
    z
      .string()
      .transform((value) => value.split(",").map((part) => part.trim()))
      .pipe(list),
  ]);
}

/**
 * A list of ids in a query string: comma-separated (`channelIds=a,b`) or repeated values, already
 * split into an array. At least one and at most `max` ids, without repeats.
 */
export function csvIdsQuerySchema(max: number) {
  const list = z
    .array(IdSchema)
    .min(1)
    .max(max)
    .refine((items) => new Set(items).size === items.length, { message: "Ids must not repeat" });
  return z.union([
    list,
    z
      .string()
      .transform((value) => value.split(",").map((part) => part.trim()))
      .pipe(list),
  ]);
}

/** An unpaginated list. Used for collections that stay small, such as projects and devices. */
export function listSchema<T extends z.ZodType>(item: T) {
  return z.object({ items: z.array(item) });
}
export interface List<T> {
  items: T[];
}
