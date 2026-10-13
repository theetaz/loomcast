import type { PublishError, PublishErrorCode } from "@loomcast/contracts";
import { publishError } from "../../modules/publisher/errors";
import type { GraphUsage } from "./usage";

// Graph API (and Threads API) errors come back as `{"error": {message, type, code, error_subcode,
// is_transient, fbtrace_id}}`. `classifyMetaError` maps them onto the publisher's `PublishError`
// codes, so adapters, token checks and the sign-in flows all decide the same way whether to retry,
// ask for a reconnect or give up.

/** The `error` object of a Graph API error response, as far as the client reads it. */
export interface GraphErrorFields {
  /** HTTP status; null when no response arrived (network error or timeout). */
  status: number | null;
  code?: number | undefined;
  subcode?: number | undefined;
  type?: string | undefined;
  isTransient?: boolean | undefined;
  fbtraceId?: string | undefined;
}

/** Throttling: app (4), user (17), Pages (32), a custom limit (613) and business use cases. */
const RATE_LIMIT_CODES: ReadonlySet<number> = new Set([4, 17, 32, 613]);
const BUSINESS_USE_CASE_RATE_LIMIT = { min: 80_000, max: 80_014 } as const;

/** Codes of media Meta could not use: unsupported video (352), bad media URL (9004), image specs. */
const INVALID_MEDIA_CODES: ReadonlySet<number> = new Set([352, 9004, 36000, 36001, 36003]);

/**
 * Media subcodes: the Instagram content publishing errors (2207xxx) and the Facebook video and
 * Reels upload errors (1363xxx). A few 2207xxx subcodes are Meta-side hiccups and stay transient.
 */
const TRANSIENT_MEDIA_SUBCODES: ReadonlySet<number> = new Set([2207001, 2207032]);

function isMediaSubcode(subcode: number): boolean {
  return (
    (subcode >= 2_207_000 && subcode < 2_208_000) || (subcode >= 1_363_000 && subcode < 1_364_000)
  );
}

/**
 * The `PublishError` code of a Graph API error:
 * - `190` (invalid or expired token) and `102` (session) → `auth`
 * - `10` and `200`–`299` (missing permission) → `permission`
 * - `4`, `17`, `32`, `613` and `80000`–`80014` (throttling) → `rate_limited`
 * - `1`, `2`, `is_transient` and HTTP 5xx, or no response at all → `transient`
 * - media codes and subcodes (`352`, `9004`, `2207xxx`, `1363xxx`) → `invalid_media`
 * - anything else → `permanent`
 */
export function classifyMetaErrorCode(fields: GraphErrorFields): PublishErrorCode {
  const { code, subcode, status } = fields;
  if (code === 190 || code === 102) {
    return "auth";
  }
  if (code === 10 || (code !== undefined && code >= 200 && code <= 299)) {
    return "permission";
  }
  if (
    code !== undefined &&
    (RATE_LIMIT_CODES.has(code) ||
      (code >= BUSINESS_USE_CASE_RATE_LIMIT.min && code <= BUSINESS_USE_CASE_RATE_LIMIT.max))
  ) {
    return "rate_limited";
  }
  if (subcode !== undefined && isMediaSubcode(subcode)) {
    return TRANSIENT_MEDIA_SUBCODES.has(subcode) ? "transient" : "invalid_media";
  }
  if (code !== undefined && INVALID_MEDIA_CODES.has(code)) {
    return "invalid_media";
  }
  if (
    code === 1 ||
    code === 2 ||
    fields.isTransient === true ||
    status === null ||
    (status !== null && status >= 500)
  ) {
    return "transient";
  }
  return "permanent";
}

/** `190` or `190/463`: the code and subcode, as `PublishError.platformCode`. */
export function metaPlatformCode(fields: GraphErrorFields): string | undefined {
  if (fields.code === undefined) {
    return fields.status === null ? undefined : `http_${fields.status}`;
  }
  return fields.subcode === undefined ? String(fields.code) : `${fields.code}/${fields.subcode}`;
}

/** Removes URLs and query strings (`?key=value`) from a platform message, so no credential leaks. */
export function sanitizeMetaMessage(message: string): string {
  return message
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(/\?[^\s=?]+=\S*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Maps a Graph API error onto a `PublishError`, with the platform code and, for throttling, how
 * long to wait (`retryAfterMs`).
 */
export function classifyMetaError(
  fields: GraphErrorFields,
  message: string,
  options: { retryAfterMs?: number | undefined } = {},
): PublishError {
  const code = classifyMetaErrorCode(fields);
  const platformCode = metaPlatformCode(fields);
  return publishError(code, sanitizeMetaMessage(message) || "The platform refused the request.", {
    ...(platformCode === undefined ? {} : { platformCode }),
    ...(code === "rate_limited" && options.retryAfterMs !== undefined
      ? { retryAfterMs: options.retryAfterMs }
      : {}),
  });
}

/**
 * A failed Graph or Threads API call. `error` is the classified `PublishError`; `fields` keep the
 * platform's code, subcode and trace id for the log. The message never contains a token, a secret
 * or a URL.
 */
export class MetaGraphError extends Error {
  constructor(
    readonly error: PublishError,
    readonly fields: GraphErrorFields,
    readonly usage: GraphUsage | null = null,
  ) {
    super(error.message);
    this.name = "MetaGraphError";
  }

  get code(): PublishErrorCode {
    return this.error.code;
  }

  /** Fields safe to log: no token, secret or URL. */
  toLog(): Record<string, unknown> {
    return {
      code: this.error.code,
      platformCode: this.error.platformCode,
      status: this.fields.status,
      type: this.fields.type,
      fbtraceId: this.fields.fbtraceId,
      message: this.error.message,
    };
  }
}
