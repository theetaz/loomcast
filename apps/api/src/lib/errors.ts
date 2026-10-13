import type { ApiError, ApiErrorCode } from "@loomcast/contracts";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/**
 * An error with a status and an `ApiError` body. Thrown anywhere in a request, it is turned into a
 * JSON response by the app's error handler.
 */
export class HttpError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: ApiErrorCode | (string & {}),
    message: string,
    readonly details?: unknown,
    readonly headers?: Record<string, string>,
  ) {
    super(message);
    this.name = "HttpError";
  }

  toBody(): ApiError {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details === undefined ? {} : { details: this.details }),
      },
    };
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new HttpError(400, "bad_request", message, details);

export const validationFailed = (details: unknown, message = "The request is not valid.") =>
  new HttpError(400, "validation_failed", message, details);

export const unauthorized = (message = "Sign in to continue.", headers?: Record<string, string>) =>
  new HttpError(401, "unauthorized", message, undefined, headers);

export const forbidden = (message = "You do not have access to this.") =>
  new HttpError(403, "forbidden", message);

export const notFound = (message = "Not found.") => new HttpError(404, "not_found", message);

export const conflict = (message: string, details?: unknown) =>
  new HttpError(409, "conflict", message, details);

export const rateLimited = (retryAfterMs: number) =>
  new HttpError(429, "rate_limited", "Too many requests. Try again later.", undefined, {
    "Retry-After": String(Math.max(1, Math.ceil(retryAfterMs / 1000))),
  });
