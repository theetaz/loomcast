import type { JsonObject } from "@loomcast/contracts";
import {
  classifyMetaError,
  type FetchLike,
  type GraphErrorFields,
  META_GRAPH_TIMEOUT_MS,
  MetaGraphError,
  parseUsageHeaders,
  sanitizeMetaMessage,
} from "../../../../lib/meta-graph";
import { publishError } from "../../errors";
import type { PlatformRequest } from "../../requests/types";

// The video upload host (`rupload.facebook.com/video-upload/<version>`) takes the token as
// `Authorization: OAuth <token>` and, for a hosted file, the public URL in a `file_url` header;
// it then fetches the video itself. It is not the Graph API, so the Graph client (Bearer token,
// form bodies) cannot send it. Its errors come as a Graph error body or as
// `{"debug_info": {"retriable", "type", "message"}}`; both map onto `MetaGraphError`.

/** The video upload host, without the API version. */
export const RUPLOAD_BASE_URL = "https://rupload.facebook.com/video-upload";

const MAX_RESPONSE_BYTES = 1024 * 1024;

export interface RuploadClient {
  /** Sends a built `rupload` step. Throws `MetaGraphError` on failure, or the caller's abort reason. */
  send(step: PlatformRequest, signal: AbortSignal): Promise<JsonObject>;
}

function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function numberOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** The `MetaGraphError` of a failed upload response. */
export function ruploadError(status: number, body: unknown, headers?: Headers): MetaGraphError {
  const usage = headers === undefined ? null : parseUsageHeaders(headers);
  const graph = asObject(asObject(body)?.error);
  if (graph !== null) {
    const fields: GraphErrorFields = {
      status,
      code: numberOf(graph.code),
      subcode: numberOf(graph.error_subcode),
      type: typeof graph.type === "string" ? graph.type.slice(0, 100) : undefined,
      isTransient: graph.is_transient === true,
    };
    const message =
      typeof graph.message === "string" ? graph.message : "The upload host refused the video.";
    return new MetaGraphError(classifyMetaError(fields, message), fields, usage);
  }
  const fields: GraphErrorFields = { status };
  const debug = asObject(asObject(body)?.debug_info);
  const type = typeof debug?.type === "string" ? debug.type.slice(0, 100) : undefined;
  const message = sanitizeMetaMessage(
    typeof debug?.message === "string" ? debug.message : `The upload host answered HTTP ${status}.`,
  );
  if (status === 401 || type?.toLowerCase().includes("auth") === true) {
    return new MetaGraphError(
      publishError("auth", message || "The upload host refused the credentials.", {
        retryable: false,
        platformCode: type ?? `http_${status}`,
      }),
      { ...fields, code: 190, type },
      usage,
    );
  }
  const transient = debug?.retriable === true || status >= 500 || status === 429;
  return new MetaGraphError(
    publishError(
      transient ? (status === 429 ? "rate_limited" : "transient") : "invalid_media",
      message || "The upload host refused the video.",
      { platformCode: type ?? `http_${status}` },
    ),
    { ...fields, type, isTransient: transient },
    usage,
  );
}

function networkError(timedOut: boolean): MetaGraphError {
  const fields: GraphErrorFields = { status: null };
  return new MetaGraphError(
    classifyMetaError(
      fields,
      timedOut
        ? "The upload host did not answer in time."
        : "The upload host could not be reached.",
    ),
    fields,
  );
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES || text === "") {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** A client of the upload host at `baseUrl` (with the version), sending built `rupload` steps. */
export function createRuploadClient(options: {
  baseUrl: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}): RuploadClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const doFetch: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const timeoutMs = options.timeoutMs ?? META_GRAPH_TIMEOUT_MS;
  return {
    async send(step, signal) {
      if (step.api !== "rupload") {
        throw new Error(`the ${step.step} step is not an upload host call`);
      }
      const url = new URL(`${baseUrl}${step.path}`);
      for (const [key, value] of Object.entries(step.query ?? {})) {
        url.searchParams.set(key, value);
      }
      const timeout = AbortSignal.timeout(timeoutMs);
      let response: Response;
      let body: unknown;
      try {
        response = await doFetch(url.toString(), {
          method: step.method,
          headers: { Accept: "application/json", ...(step.headers ?? {}) },
          redirect: "error",
          signal: AbortSignal.any([signal, timeout]),
        });
        body = await readBody(response);
      } catch (error) {
        if (signal.aborted) {
          throw signal.reason ?? error;
        }
        throw networkError(timeout.aborted);
      }
      const object = asObject(body);
      if (!response.ok || object === null || object.error !== undefined) {
        throw ruploadError(response.status, body, response.headers);
      }
      if (object.success !== true) {
        const fields: GraphErrorFields = { status: response.status, isTransient: true };
        throw new MetaGraphError(
          classifyMetaError(fields, "The upload host did not confirm the upload."),
          fields,
        );
      }
      return object;
    },
  };
}
