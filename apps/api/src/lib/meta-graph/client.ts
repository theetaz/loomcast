import type { JsonObject } from "@loomcast/contracts";
import { classifyMetaError, type GraphErrorFields, MetaGraphError } from "./errors";
import { appSecretProof } from "./proof";
import { type GraphUsage, parseUsageHeaders, regainAccessDelayMs } from "./usage";

// One HTTP client for the Graph API and the Threads API. Every call goes to the versioned base URL
// (`<host>/<version><path>`) with the access token and its `appsecret_proof`, has a 15 s timeout,
// and is retried with jittered backoff when the failure is transient and the call is safe to
// repeat. Errors are `MetaGraphError`s classified onto the publisher's error codes, and every
// response's throttling headers are kept. Nothing here logs: URLs carry credentials (`client_secret`,
// `fb_exchange_token`), so neither a URL nor a token ever appears in an error message.

/** Longest a single call may take, including reading the body. */
export const META_GRAPH_TIMEOUT_MS = 15_000;

/** Further attempts after a transient failure of a call that may be repeated. */
export const META_GRAPH_MAX_RETRIES = 2;

/** First retry delay; each further one doubles, varied by ±50%. */
export const META_GRAPH_RETRY_BASE_MS = 500;

/** Largest response body the client reads. */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export type GraphParamValue = string | number | boolean | null | undefined;
export type GraphParams = Readonly<Record<string, GraphParamValue>>;

export interface GraphClientOptions {
  /** Host, such as `https://graph.facebook.com`, without a version or trailing slash. */
  baseUrl: string;
  /** Version path segment, such as `v26.0`. */
  version: string;
  /**
   * The app secret `appsecret_proof` is computed with. Null leaves the proof out (the Threads API
   * does not document it).
   */
  appSecret: string | null;
  /**
   * Where the access token goes: the `Authorization: Bearer` header (Graph API), or the
   * `access_token` parameter (Threads API: the query of a GET, the form body of a POST).
   */
  tokenPlacement?: "header" | "parameter";
  timeoutMs?: number;
  maxRetries?: number;
  retryBaseMs?: number;
  /** Defaults to the global `fetch`. */
  fetch?: FetchLike;
  /** Jitter source, in [0, 1). */
  random?: () => number;
  /** Waits between retries; tests pass one that returns at once. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface GraphRequest {
  method?: "GET" | "POST" | "DELETE";
  /** Path after the version, starting with `/`, such as `/me/accounts`. */
  path: string;
  query?: GraphParams;
  /** Form fields of a POST (`application/x-www-form-urlencoded`). */
  form?: GraphParams;
  /** The token the call is made with; it also gets an `appsecret_proof`. */
  accessToken?: string | null;
  /** False for the unversioned endpoints, such as the Threads token exchanges. */
  versioned?: boolean;
  /**
   * Whether a transient failure is retried. Defaults to true for GET and false otherwise: a POST
   * that timed out may already have taken effect.
   */
  retry?: boolean;
  signal?: AbortSignal;
}

export interface GraphResponse<T> {
  status: number;
  data: T;
  /** The throttling headers of the response; null when it had none. */
  usage: GraphUsage | null;
}

export interface GraphClient {
  readonly baseUrl: string;
  readonly version: string;
  /** Sends one call. Throws `MetaGraphError` on any failure, or the caller's abort reason. */
  request<T = JsonObject>(request: GraphRequest): Promise<GraphResponse<T>>;
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

function setParams(target: URLSearchParams, params: GraphParams | undefined): void {
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined && value !== null) {
      target.set(key, String(value));
    }
  }
}

function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function numberOf(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && /^\d{1,12}$/.test(value)) {
    return Number(value);
  }
  return undefined;
}

/** The error fields and message of a Graph API error body (`{"error": {...}}`), if it has one. */
function graphErrorOf(
  status: number,
  body: unknown,
): { fields: GraphErrorFields; message: string } | null {
  const error = asObject(asObject(body)?.error);
  if (error === null) {
    return null;
  }
  return {
    fields: {
      status,
      code: numberOf(error.code),
      subcode: numberOf(error.error_subcode),
      type: typeof error.type === "string" ? error.type.slice(0, 100) : undefined,
      isTransient: error.is_transient === true,
      fbtraceId: typeof error.fbtrace_id === "string" ? error.fbtrace_id.slice(0, 100) : undefined,
    },
    message:
      typeof error.message === "string" ? error.message : "The platform refused the request.",
  };
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

function networkError(timedOut: boolean): MetaGraphError {
  const fields: GraphErrorFields = { status: null };
  return new MetaGraphError(
    classifyMetaError(
      fields,
      timedOut ? "The platform did not answer in time." : "The platform could not be reached.",
    ),
    fields,
  );
}

export function createGraphClient(options: GraphClientOptions): GraphClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const version = options.version;
  const placement = options.tokenPlacement ?? "header";
  const timeoutMs = options.timeoutMs ?? META_GRAPH_TIMEOUT_MS;
  const maxRetries = options.maxRetries ?? META_GRAPH_MAX_RETRIES;
  const retryBaseMs = options.retryBaseMs ?? META_GRAPH_RETRY_BASE_MS;
  const doFetch: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? defaultSleep;

  function build(request: GraphRequest): { url: string; init: RequestInit } {
    const method = request.method ?? "GET";
    const prefix = request.versioned === false ? "" : `/${version}`;
    const url = new URL(`${baseUrl}${prefix}${request.path}`);
    setParams(url.searchParams, request.query);
    const headers = new Headers({ Accept: "application/json" });
    const form = new URLSearchParams();
    setParams(form, request.form);
    const token = request.accessToken ?? null;
    if (token !== null) {
      const proof = options.appSecret === null ? null : appSecretProof(token, options.appSecret);
      if (placement === "header") {
        headers.set("Authorization", `Bearer ${token}`);
        if (proof !== null) {
          url.searchParams.set("appsecret_proof", proof);
        }
      } else {
        const target = method === "POST" ? form : url.searchParams;
        target.set("access_token", token);
        if (proof !== null) {
          target.set("appsecret_proof", proof);
        }
      }
    }
    const init: RequestInit = { method, headers, redirect: "error" };
    if (method === "POST") {
      headers.set("Content-Type", "application/x-www-form-urlencoded");
      init.body = form.toString();
    }
    return { url: url.toString(), init };
  }

  async function once<T>(request: GraphRequest): Promise<GraphResponse<T>> {
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
      throw networkError(timeout.aborted);
    }
    const usage = parseUsageHeaders(response.headers);
    const graphError = graphErrorOf(response.status, body);
    if (graphError !== null || !response.ok) {
      const fields = graphError?.fields ?? { status: response.status };
      const message = graphError?.message ?? `The platform answered HTTP ${response.status}.`;
      throw new MetaGraphError(
        classifyMetaError(fields, message, { retryAfterMs: regainAccessDelayMs(usage) }),
        fields,
        usage,
      );
    }
    if (body === undefined) {
      const fields: GraphErrorFields = { status: response.status };
      throw new MetaGraphError(
        classifyMetaError({ ...fields, isTransient: true }, "The platform answered without JSON."),
        fields,
        usage,
      );
    }
    return { status: response.status, data: body as T, usage };
  }

  return {
    baseUrl,
    version,
    async request<T = JsonObject>(request: GraphRequest): Promise<GraphResponse<T>> {
      const retry = request.retry ?? (request.method ?? "GET") === "GET";
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await once<T>(request);
        } catch (error) {
          const retryable =
            retry &&
            attempt < maxRetries &&
            error instanceof MetaGraphError &&
            error.error.code === "transient" &&
            request.signal?.aborted !== true;
          if (!retryable) {
            throw error;
          }
          const delay = retryBaseMs * 2 ** attempt * (0.5 + random());
          await sleep(Math.round(delay), request.signal);
        }
      }
    },
  };
}
