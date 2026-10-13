import type { PublishError } from "@loomcast/contracts";
import { parseMetaCheckConfig } from "../../../../env";
import {
  createMetaGraphClient,
  type GraphClient,
  type GraphParams,
  type GraphResponse,
  MetaGraphError,
} from "../../../../lib/meta-graph";
import { PublishFailure, publishError } from "../../errors";
import type { PlatformRequest, RequestFields, RequestFieldValue } from "../../requests";

// How the Instagram adapter talks to the Graph API: it sends the steps the pure builders in
// `requests/instagram.ts` produce through the shared Graph client (versioned base URL,
// `appsecret_proof`, timeouts, retries of safe calls), and turns every Graph error into a
// `PublishFailure` with the Instagram content publishing subcodes read the way Meta's error
// reference describes them.

/** How long a post waits when the account's 24-hour publishing quota is used up. */
export const INSTAGRAM_QUOTA_RETRY_MS = 60 * 60_000;

/** Where the adapter gets its Graph client: a client, or a function building one on first use. */
export type GraphClientSource = GraphClient | (() => GraphClient);

/**
 * The Graph client of the server's Meta app, from `META_*` in the environment (the same settings
 * the sign-in flow uses). A server without a Meta app cannot publish to Instagram.
 */
export function graphClientFromEnv(env: Record<string, string | undefined> = process.env) {
  let platforms: ReturnType<typeof parseMetaCheckConfig>;
  try {
    platforms = parseMetaCheckConfig(env);
  } catch {
    throw PublishFailure.of("not_configured", "The Meta app settings are invalid.", {
      retryable: false,
    });
  }
  if (platforms.meta === null) {
    throw PublishFailure.of("not_configured", "The Meta app is not configured on the server.", {
      retryable: false,
    });
  }
  return createMetaGraphClient(platforms);
}

/** Resolves `source` once; a failure (such as a missing Meta app) is retried on the next call. */
export function lazyGraphClient(source: GraphClientSource): () => GraphClient {
  if (typeof source !== "function") {
    return () => source;
  }
  let client: GraphClient | null = null;
  return () => {
    client ??= source();
    return client;
  };
}

/** A Graph form value: the builders' JSON fields, flattened the way the Graph API reads forms. */
function formValue(value: RequestFieldValue): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

function formOf(body: RequestFields | undefined): GraphParams | undefined {
  if (body === undefined) {
    return undefined;
  }
  return Object.fromEntries(Object.entries(body).map(([key, value]) => [key, formValue(value)]));
}

/**
 * The publishing error of an Instagram content publishing subcode, where Meta's error reference
 * reads it differently from the shared classification (which counts every 2207xxx subcode as a
 * media problem). Undefined keeps the shared classification.
 */
function instagramOverride(error: MetaGraphError): PublishError | undefined {
  const { subcode } = error.fields;
  const base = error.error;
  const options = base.platformCode === undefined ? {} : { platformCode: base.platformCode };
  switch (subcode) {
    // 9/2207042: the account reached its content publishing limit; try again later.
    case 2_207_042:
      return publishError(
        "rate_limited",
        "The Instagram account reached its 24-hour publishing limit.",
        { ...options, retryAfterMs: INSTAGRAM_QUOTA_RETRY_MS },
      );
    // -2/2207003: downloading the video took too long; -1/2207053: unknown upload error;
    // 24/2207008: the container is briefly unavailable. Meta advises retrying all three.
    case 2_207_003:
    case 2_207_053:
    case 2_207_008:
      return publishError("transient", base.message, options);
    // 25/2207050: the account is restricted until its owner acts in the Instagram app.
    case 2_207_050:
      return publishError("permission", base.message, { ...options, retryable: false });
    // 4/2207051: the activity was restricted as possible spam; retrying makes it worse.
    case 2_207_051:
      return publishError("permanent", base.message, { ...options, retryable: false });
    default:
      return undefined;
  }
}

/** The `PublishError` of a failed Graph call. */
export function instagramErrorOf(error: MetaGraphError): PublishError {
  return instagramOverride(error) ?? error.error;
}

/** True for `9007/2207027`: the container is not ready for `media_publish` yet. */
export function isNotReadyError(error: unknown): boolean {
  return (
    error instanceof MetaGraphError &&
    (error.fields.subcode === 2_207_027 || error.fields.code === 9_007)
  );
}

/**
 * Sends one builder step through `client` with `accessToken` (the client puts it in the
 * `Authorization` header with its `appsecret_proof`). JSON bodies go as form fields, which the
 * Graph API reads the same way. A Graph error becomes a `PublishFailure`; an abort is rethrown.
 */
export async function sendStep<T>(
  client: GraphClient,
  step: PlatformRequest,
  input: { accessToken: string; signal: AbortSignal; raw?: boolean },
): Promise<GraphResponse<T>> {
  if (step.api !== "graph") {
    throw new Error(`the Instagram adapter cannot send a ${step.api} request`);
  }
  try {
    return await client.request<T>({
      method: step.method,
      path: step.path,
      query: step.query,
      form: formOf(step.body),
      accessToken: input.accessToken,
      signal: input.signal,
    });
  } catch (error) {
    if (error instanceof MetaGraphError && input.raw !== true) {
      throw new PublishFailure(instagramErrorOf(error));
    }
    throw error;
  }
}

/** A `PublishFailure` for a `MetaGraphError`; anything else is returned unchanged. */
export function asPublishFailure(error: unknown): unknown {
  return error instanceof MetaGraphError ? new PublishFailure(instagramErrorOf(error)) : error;
}
