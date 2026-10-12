import { z } from "zod";

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

/** An unpaginated list. Used for collections that stay small, such as projects and devices. */
export function listSchema<T extends z.ZodType>(item: T) {
  return z.object({ items: z.array(item) });
}
export interface List<T> {
  items: T[];
}
