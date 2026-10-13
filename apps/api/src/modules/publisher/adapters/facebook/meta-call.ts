import type { Platform, PublishError } from "@loomcast/contracts";
import {
  DEFAULT_META_GRAPH_BASE_URL,
  DEFAULT_META_GRAPH_VERSION,
  DEFAULT_THREADS_GRAPH_BASE_URL,
  type PlatformsConfig,
} from "../../../../env";
import {
  type FetchLike,
  type GraphClientOptions,
  type GraphParams,
  type GraphRequest,
  MetaGraphError,
} from "../../../../lib/meta-graph";
import { PublishFailure } from "../../errors";
import type { PlatformRequest, RequestFields, RequestFieldValue } from "../../requests/types";
import type { ChannelCredentials, PublishContext } from "../../types";

// What the Facebook and Threads adapters share: their options, the translation of a built
// request step into a call of the Graph API client, and the mapping of the client's errors onto
// `PublishFailure`s. When the platform refuses a channel's credentials, the adapter reports it
// through `onCredentialsRefused`, which the publisher wires to the channels module's reauth path.

/** The platform settings the Meta adapters read. */
export type MetaPlatforms = Pick<
  PlatformsConfig,
  "metaGraphBaseUrl" | "metaGraphVersion" | "threadsGraphBaseUrl" | "meta"
>;

/** Default hosts with no Meta app: the Facebook adapter refuses with `not_configured`. */
export const UNCONFIGURED_META_PLATFORMS: MetaPlatforms = Object.freeze({
  metaGraphBaseUrl: DEFAULT_META_GRAPH_BASE_URL,
  metaGraphVersion: DEFAULT_META_GRAPH_VERSION,
  threadsGraphBaseUrl: DEFAULT_THREADS_GRAPH_BASE_URL,
  meta: null,
});

/** Why a channel's credentials no longer work. */
export type CredentialsRefusalReason = "token_refused" | "unreadable_credentials";

export interface CredentialsRefusal {
  channelId: string;
  platform: Platform;
  error: PublishError;
  reason: CredentialsRefusalReason;
}

export interface MetaAdapterOptions {
  platforms: MetaPlatforms;
  /** Replaces the global `fetch`. */
  fetch?: FetchLike;
  /** Waits between the client's retries of a safe call; tests pass one that returns at once. */
  sleep?: GraphClientOptions["sleep"];
  /** Video upload host, without the version (`https://rupload.facebook.com/video-upload`). */
  ruploadBaseUrl?: string;
  /**
   * Told when the platform refuses the channel's credentials (`auth` or `permission`), so the
   * channel can be flagged `needs_reauth`. Errors it throws are logged and otherwise ignored.
   */
  onCredentialsRefused?: (refusal: CredentialsRefusal) => Promise<void>;
}

/** The Graph client options the adapter's settings imply. */
export function clientOptions(options: MetaAdapterOptions): Partial<GraphClientOptions> {
  return {
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
  };
}

/**
 * Whether an error means the channel must be reconnected: the token was refused or lacks a
 * permission. Mirrors the channels module's `refusesCredentials`.
 */
export function refusesCredentials(error: PublishError): boolean {
  return error.code === "auth" || error.code === "permission";
}

async function reportRefusal(
  context: PublishContext,
  options: MetaAdapterOptions,
  error: PublishError,
  reason: CredentialsRefusalReason,
): Promise<void> {
  if (options.onCredentialsRefused === undefined) {
    return;
  }
  try {
    await options.onCredentialsRefused({
      channelId: context.channel.id,
      platform: context.platform,
      error: { ...error, retryable: false },
      reason,
    });
  } catch (thrown) {
    context.logger.error(
      { err: thrown, channelId: context.channel.id },
      "could not flag the channel for reconnecting",
    );
  }
}

/**
 * The channel's credentials. Credentials that cannot be read are reported as refused before the
 * failure is rethrown.
 */
export async function credentialsOf(
  context: PublishContext,
  options: MetaAdapterOptions,
): Promise<ChannelCredentials> {
  try {
    return await context.secrets();
  } catch (error) {
    if (error instanceof PublishFailure && error.error.code === "auth") {
      await reportRefusal(context, options, error.error, "unreadable_credentials");
    }
    throw error;
  }
}

/**
 * Runs one platform call. A `MetaGraphError` becomes a `PublishFailure` with the classified
 * error (logged without credentials); a refused token is reported first.
 */
export async function metaCall<T>(
  context: PublishContext,
  options: MetaAdapterOptions,
  step: string,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof MetaGraphError)) {
      throw error;
    }
    context.logger.warn(
      { ...error.toLog(), step, platform: context.platform },
      "a publishing call failed",
    );
    if (refusesCredentials(error.error)) {
      await reportRefusal(context, options, error.error, "token_refused");
    }
    throw new PublishFailure(error.error);
  }
}

type GraphParamValue = GraphParams[string];

function fieldValue(value: RequestFieldValue): GraphParamValue {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? value
    : JSON.stringify(value);
}

function withoutToken(fields: RequestFields | Record<string, string> | undefined): GraphParams {
  const out: Record<string, GraphParamValue> = {};
  for (const [key, value] of Object.entries(fields ?? {})) {
    if (key !== "access_token") {
      out[key] = fieldValue(value);
    }
  }
  return out;
}

/**
 * The Graph client call of a built `graph` or `threads` step. The token moves from the step's
 * `Authorization` header or `access_token` field to where the client puts it (with its
 * `appsecret_proof` on the Graph API); POST fields go form-encoded, which the Graph API reads the
 * same as JSON. POSTs are not retried by the client: one that timed out may have taken effect.
 */
export function toGraphRequest(
  step: PlatformRequest,
  accessToken: string,
  signal: AbortSignal,
): GraphRequest {
  if (step.api !== "graph" && step.api !== "threads") {
    throw new Error(`the ${step.step} step is not a Graph API call`);
  }
  return {
    method: step.method,
    path: step.path,
    query: withoutToken(step.query),
    ...(step.method === "POST" ? { form: withoutToken(step.body) } : {}),
    accessToken,
    signal,
  };
}

/** The step named `name` of a built plan. */
export function stepOf(steps: readonly PlatformRequest[], name: string): PlatformRequest {
  const step = steps.find((candidate) => candidate.step === name);
  if (step === undefined) {
    throw new Error(`the publish plan has no ${name} step`);
  }
  return step;
}
