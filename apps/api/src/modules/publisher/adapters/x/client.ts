import type { JsonObject, PublishError } from "@loomcast/contracts";
import {
  type FetchLike,
  type GraphErrorFields,
  MetaGraphError,
  sanitizeMetaMessage,
} from "../../../../lib/meta-graph";
import { publishError } from "../../errors";

// One HTTP client for the X API v2 (`https://api.x.com`). Every call has a timeout, reads the
// rate-limit headers (`x-rate-limit-*` per endpoint and `x-user-limit-24hour-*` on posting), and
// fails with an `XApiError` classified onto the publisher's error codes. Safe calls (GET) are
// retried with jittered backoff on transient failures; a POST is never repeated here, because a
// call that timed out may already have taken effect. Nothing here logs, and no error message
// carries a token, a secret or a URL.
//
// `XApiError` extends `MetaGraphError` so the sign-in callback and the channel sweeps, which
// already handle platform errors that way, treat X failures the same.

/** Longest a single call may take, including reading the body. Appends carry 4 MB. */
export const X_API_TIMEOUT_MS = 60_000;

/** Further attempts after a transient failure of a GET. */
export const X_API_MAX_RETRIES = 2;

/** First retry delay; each further one doubles, varied by ±50%. */
export const X_API_RETRY_BASE_MS = 500;

/** Shortest wait asked for after a 429 without a usable reset header. */
export const X_RATE_LIMIT_FALLBACK_MS = 15 * 60_000;

/** Largest response body the client reads. */
const MAX_RESPONSE_BYTES = 1024 * 1024;

/**
 * The rate-limit headers of one response. `x-rate-limit-*` are the endpoint's 15-minute window;
 * `x-user-limit-24hour-*` the user's daily posting allowance (on `POST /2/tweets`). Resets are
 * epoch seconds on the wire and ISO times here.
 */
export interface XRateLimit {
  limit: number | null;
  remaining: number | null;
  resetAt: string | null;
  userDayLimit: number | null;
  userDayRemaining: number | null;
  userDayResetAt: string | null;
}

function headerNumber(headers: Headers, name: string): number | null {
  const value = headers.get(name);
  return value !== null && /^\d{1,12}$/.test(value.trim()) ? Number(value.trim()) : null;
}

function headerTime(headers: Headers, name: string): string | null {
  const seconds = headerNumber(headers, name);
  return seconds === null ? null : new Date(seconds * 1000).toISOString();
}

/** The rate-limit headers of `headers`, or null when it has none. */
export function parseXRateLimit(headers: Headers): XRateLimit | null {
  const rate: XRateLimit = {
    limit: headerNumber(headers, "x-rate-limit-limit"),
    remaining: headerNumber(headers, "x-rate-limit-remaining"),
    resetAt: headerTime(headers, "x-rate-limit-reset"),
    userDayLimit: headerNumber(headers, "x-user-limit-24hour-limit"),
    userDayRemaining: headerNumber(headers, "x-user-limit-24hour-remaining"),
    userDayResetAt: headerTime(headers, "x-user-limit-24hour-reset"),
  };
  return Object.values(rate).every((value) => value === null) ? null : rate;
}

/**
 * How long to wait after a 429: until the exhausted window resets (the daily one when it is the
 * one used up), at least a second; `X_RATE_LIMIT_FALLBACK_MS` without a reset header.
 */
export function xRetryAfterMs(rate: XRateLimit | null, now: Date): number {
  const reset =
    rate?.userDayRemaining === 0 && rate.userDayResetAt !== null
      ? rate.userDayResetAt
      : (rate?.resetAt ?? rate?.userDayResetAt ?? null);
  if (reset === null) {
    return X_RATE_LIMIT_FALLBACK_MS;
  }
  return Math.max(1_000, Date.parse(reset) - now.getTime());
}

/** A failed X API call. `rateLimit` holds the response's rate-limit headers, if any. */
export class XApiError extends MetaGraphError {
  constructor(
    error: PublishError,
    fields: GraphErrorFields,
    readonly rateLimit: XRateLimit | null = null,
  ) {
    super(error, fields, null);
    this.name = "XApiError";
  }
}

function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

/** The title and message of an X error body: problem details, `errors[]`, or OAuth errors. */
function xErrorOf(body: unknown): { title: string | undefined; message: string | undefined } {
  const object = asObject(body);
  if (object === null) {
    return { title: undefined, message: undefined };
  }
  const text = (value: unknown) => (typeof value === "string" ? value : undefined);
  const first = Array.isArray(object.errors) ? asObject(object.errors[0]) : null;
  return {
    title: text(object.title) ?? text(object.error) ?? text(first?.title),
    message:
      text(object.detail) ??
      text(object.error_description) ??
      text(first?.detail) ??
      text(first?.message) ??
      text(object.title),
  };
}

/**
 * The `PublishError` of a failed X call:
 * - 401, and an OAuth `invalid_grant` or `invalid_token` → `auth`
 * - 429 → `rate_limited`, with `retryAfterMs` from the reset headers
 * - 403 → `invalid_media` when the refusal is about the video, `permanent` for a duplicate post,
 *   otherwise `permission`
 * - 5xx, or no response → `transient`
 * - anything else → `permanent`
 */
export function classifyXError(
  status: number | null,
  body: unknown,
  rate: XRateLimit | null,
  now: Date,
): { error: PublishError; fields: GraphErrorFields } {
  const { title, message } = xErrorOf(body);
  const text = sanitizeMetaMessage(message ?? "") || "The X API refused the request.";
  const fields: GraphErrorFields = { status, type: title?.slice(0, 100) };
  const platformCode = status === null ? undefined : `http_${status}`;
  const options = platformCode === undefined ? {} : { platformCode };
  let error: PublishError;
  if (status === null) {
    error = publishError("transient", text, options);
  } else if (status === 401 || title === "invalid_grant" || title === "invalid_token") {
    error = publishError("auth", text, options);
  } else if (status === 429) {
    error = publishError("rate_limited", text, {
      ...options,
      retryAfterMs: xRetryAfterMs(rate, now),
    });
  } else if (status === 403) {
    const code = /duplicate/i.test(text)
      ? "permanent"
      : /video|media/i.test(text)
        ? "invalid_media"
        : "permission";
    error = publishError(code, text, options);
  } else if (status >= 500) {
    error = publishError("transient", text, options);
  } else {
    error = publishError("permanent", text, options);
  }
  return { error, fields };
}

export interface XRequest {
  method?: "GET" | "POST";
  /** Path starting with `/2/`. */
  path: string;
  query?: Readonly<Record<string, string>>;
  /** A JSON body. */
  json?: JsonObject;
  /** A form body (`application/x-www-form-urlencoded`), for the OAuth token endpoint. */
  form?: Readonly<Record<string, string>>;
  /** A multipart body, for media appends. */
  multipart?: FormData;
  /** The user's OAuth 2.0 bearer token. */
  accessToken?: string;
  /** The app's client credentials, sent as HTTP Basic (confidential client token calls). */
  client?: { clientId: string; clientSecret: string };
  /** Defaults to true for GET and false otherwise. */
  retry?: boolean;
  signal?: AbortSignal;
}

export interface XResponse<T> {
  status: number;
  data: T;
  rateLimit: XRateLimit | null;
}

export interface XClientOptions {
  /** API host, such as `https://api.x.com`, without a trailing slash. */
  baseUrl: string;
  timeoutMs?: number;
  maxRetries?: number;
  retryBaseMs?: number;
  /** Defaults to the global `fetch`. */
  fetch?: FetchLike;
  random?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => Date;
}

export interface XClient {
  readonly baseUrl: string;
  /** Sends one call. Throws `XApiError` on any failure, or the caller's abort reason. */
  request<T = JsonObject>(request: XRequest): Promise<XResponse<T>>;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) {
    throw new Error("response too large");
  }
  if (text === "") {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export function createXClient(options: XClientOptions): XClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs ?? X_API_TIMEOUT_MS;
  const maxRetries = options.maxRetries ?? X_API_MAX_RETRIES;
  const retryBaseMs = options.retryBaseMs ?? X_API_RETRY_BASE_MS;
  const doFetch: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? (() => new Date());

  function build(request: XRequest): { url: string; init: RequestInit } {
    const url = new URL(`${baseUrl}${request.path}`);
    for (const [key, value] of Object.entries(request.query ?? {})) {
      url.searchParams.set(key, value);
    }
    const headers = new Headers({ Accept: "application/json" });
    if (request.accessToken !== undefined) {
      headers.set("Authorization", `Bearer ${request.accessToken}`);
    } else if (request.client !== undefined) {
      const basic = Buffer.from(
        `${encodeURIComponent(request.client.clientId)}:${encodeURIComponent(request.client.clientSecret)}`,
      ).toString("base64");
      headers.set("Authorization", `Basic ${basic}`);
    }
    const init: RequestInit = { method: request.method ?? "GET", headers, redirect: "error" };
    if (request.json !== undefined) {
      headers.set("Content-Type", "application/json");
      init.body = JSON.stringify(request.json);
    } else if (request.form !== undefined) {
      headers.set("Content-Type", "application/x-www-form-urlencoded");
      init.body = new URLSearchParams(request.form).toString();
    } else if (request.multipart !== undefined) {
      // fetch sets the multipart content type with its boundary.
      init.body = request.multipart;
    }
    return { url: url.toString(), init };
  }

  async function once<T>(request: XRequest): Promise<XResponse<T>> {
    const { url, init } = build(request);
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal =
      request.signal === undefined ? timeout : AbortSignal.any([request.signal, timeout]);
    let response: Response;
    let body: unknown;
    try {
      response = await doFetch(url, { ...init, signal });
      body = await readBody(response);
    } catch (error) {
      if (request.signal?.aborted) {
        throw request.signal.reason ?? error;
      }
      const { error: classified, fields } = classifyXError(
        null,
        {
          detail: timeout.aborted
            ? "The X API did not answer in time."
            : "The X API could not be reached.",
        },
        null,
        now(),
      );
      throw new XApiError(classified, fields);
    }
    const rateLimit = parseXRateLimit(response.headers);
    const object = asObject(body);
    // X answers some failures with HTTP 200 and an `errors` array without `data`.
    const failedWithData = object !== null && Array.isArray(object.errors) && !("data" in object);
    if (!response.ok || failedWithData) {
      const { error, fields } = classifyXError(
        response.ok ? 400 : response.status,
        body,
        rateLimit,
        now(),
      );
      throw new XApiError(error, fields, rateLimit);
    }
    if (body === undefined) {
      const { error, fields } = classifyXError(
        502,
        { detail: "The X API answered without JSON." },
        rateLimit,
        now(),
      );
      throw new XApiError(error, fields, rateLimit);
    }
    return { status: response.status, data: body as T, rateLimit };
  }

  return {
    baseUrl,
    async request<T = JsonObject>(request: XRequest): Promise<XResponse<T>> {
      const retry = request.retry ?? (request.method ?? "GET") === "GET";
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await once<T>(request);
        } catch (error) {
          const retryable =
            retry &&
            attempt < maxRetries &&
            error instanceof XApiError &&
            error.error.code === "transient" &&
            request.signal?.aborted !== true;
          if (!retryable) {
            throw error;
          }
          await sleep(Math.round(retryBaseMs * 2 ** attempt * (0.5 + random())), request.signal);
        }
      }
    },
  };
}
