import {
  PUBLISH_ERROR_MESSAGE_MAX_LENGTH,
  type PublishError,
  type PublishErrorCode,
  RETRYABLE_PUBLISH_ERROR_CODES,
} from "@loomcast/contracts";

const RETRYABLE: ReadonlySet<PublishErrorCode> = new Set(RETRYABLE_PUBLISH_ERROR_CODES);

/** Whether a failure with `code` is worth retrying, unless the adapter knows better. */
export function isRetryableCode(code: PublishErrorCode): boolean {
  return RETRYABLE.has(code);
}

/**
 * A `PublishError`. `retryable` defaults to the code's default (`rate_limited` and `transient`).
 * The message is cut to the contract's limit; it must never contain credentials or URLs with
 * query strings.
 */
export function publishError(
  code: PublishErrorCode,
  message: string,
  options: { retryable?: boolean; retryAfterMs?: number; platformCode?: string } = {},
): PublishError {
  return {
    code,
    retryable: options.retryable ?? isRetryableCode(code),
    ...(options.retryAfterMs === undefined
      ? {}
      : { retryAfterMs: Math.max(0, Math.round(options.retryAfterMs)) }),
    ...(options.platformCode === undefined
      ? {}
      : { platformCode: options.platformCode.slice(0, 100) }),
    message: message.slice(0, PUBLISH_ERROR_MESSAGE_MAX_LENGTH),
  };
}

/**
 * What an adapter throws when a publish or status call fails. The publisher records `error` on
 * the attempt and the post, then retries (when `error.retryable` and attempts remain) or fails
 * the post.
 */
export class PublishFailure extends Error {
  constructor(readonly error: PublishError) {
    super(error.message);
    this.name = "PublishFailure";
  }

  static of(
    code: PublishErrorCode,
    message: string,
    options?: Parameters<typeof publishError>[2],
  ): PublishFailure {
    return new PublishFailure(publishError(code, message, options));
  }
}

/**
 * The `PublishError` for anything an adapter throws. A `PublishFailure` keeps its error; any other
 * exception is a retryable `transient` failure with a generic message (the server log has the
 * details), so an exception text never leaks a URL or a token into a post.
 */
export function toPublishError(error: unknown): PublishError {
  if (error instanceof PublishFailure) {
    return error.error;
  }
  return publishError("transient", "The platform call failed unexpectedly; see the server log.");
}
