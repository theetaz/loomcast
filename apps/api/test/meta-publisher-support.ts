import { randomUUID } from "node:crypto";
import type { JsonObject, Platform, VideoPublishRequest } from "@loomcast/contracts";
import { createLogger } from "../src/lib/logger";
import {
  buildCaption,
  createDryRunAdapter,
  type PublishContext,
  type PublisherAdapter,
  PublishFailure,
  redactRequest,
} from "../src/modules/publisher";
import type { MetaPlatforms } from "../src/modules/publisher/adapters/facebook";
import { fakeCredential, fakeId, fakeMetaApp, GRAPH_ORIGIN, GRAPH_VERSION } from "./oauth-support";

// The Facebook and Threads adapter tests answer every platform call with a scripted `fetch`
// passed to the adapter, so nothing leaves the process. Tokens and ids are generated per run.

export const THREADS_API_ORIGIN = "https://graph.threads.test";
export const RUPLOAD_ORIGIN = "https://rupload.example.test/video-upload";

/** Platform settings with a Meta app (or none) and test hosts. */
export function testPlatforms(options: { metaApp?: boolean } = {}): MetaPlatforms {
  return {
    metaGraphBaseUrl: GRAPH_ORIGIN,
    metaGraphVersion: GRAPH_VERSION,
    threadsGraphBaseUrl: THREADS_API_ORIGIN,
    meta: options.metaApp === false ? null : fakeMetaApp(),
  };
}

/** A call the scripted fetch answered. */
export interface SeenCall {
  method: string;
  url: URL;
  headers: Headers;
  /** The form fields of a POST (empty for other calls). */
  form: URLSearchParams;
}

export interface Reply {
  status?: number;
  body: unknown;
}

interface Route {
  method: string;
  pathname: string;
  reply: Reply | ((call: SeenCall) => Reply);
}

/** A `fetch` that answers scripted calls in order of registration and refuses any other. */
export function scriptedFetch() {
  const routes: Route[] = [];
  const calls: SeenCall[] = [];
  const fetch = async (input: string, init: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const method = (init.method ?? "GET").toUpperCase();
    const call: SeenCall = {
      method,
      url,
      headers: new Headers(init.headers),
      form: new URLSearchParams(typeof init.body === "string" ? init.body : ""),
    };
    calls.push(call);
    const index = routes.findIndex(
      (route) => route.method === method && route.pathname === url.pathname,
    );
    const route = index === -1 ? undefined : routes.splice(index, 1)[0];
    if (route === undefined) {
      throw new Error(`unexpected ${method} ${url.pathname}`);
    }
    const reply = typeof route.reply === "function" ? route.reply(call) : route.reply;
    return new Response(JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };
  return {
    fetch,
    calls,
    /** Answers the next `method` call to `pathname` (the full path, with the version). */
    on(method: string, pathname: string, reply: Reply | ((call: SeenCall) => Reply)) {
      routes.push({ method, pathname, reply });
      return this;
    },
    /** Calls that were scripted but never made. */
    pending(): string[] {
      return routes.map((route) => `${route.method} ${route.pathname}`);
    },
  };
}

/** A Graph API error body. */
export function graphErrorBody(code: number, message: string, subcode?: number): unknown {
  return {
    error: {
      message,
      type: "OAuthException",
      code,
      ...(subcode === undefined ? {} : { error_subcode: subcode }),
      fbtrace_id: "trace",
    },
  };
}

export interface FakeContext extends PublishContext {
  readonly recorded: { request?: JsonObject; response?: JsonObject };
  readonly token: string;
  readonly request: VideoPublishRequest;
}

export interface ContextOptions {
  dryRun?: boolean;
  externalContainerId?: string | null;
  externalId?: string | null;
  durationMs?: number;
  width?: number;
  height?: number;
  bytes?: number;
  caption?: string;
  /** Makes `secrets()` throw what the real context throws for unreadable credentials. */
  unreadableSecrets?: boolean;
}

const silentLogger = createLogger({ level: "silent" });

/** A publish context for `platform` with a generated account, token and public video URL. */
export function fakeContext(platform: Platform, options: ContextOptions = {}): FakeContext {
  const accountId = fakeId();
  const token = fakeCredential("page-token");
  const postId = randomUUID();
  const caption = buildCaption(platform, {
    text: options.caption ?? "Ownership in sixty seconds",
    hashtags: ["rust"],
  });
  const request: VideoPublishRequest = {
    platform,
    format: "reel",
    externalId: accountId,
    videoUrl: options.dryRun
      ? `https://dry-run.invalid/p/${postId}/render.mp4`
      : `https://media.example.test/p/${postId}/render.mp4`,
    caption: caption.text,
    durationMs: options.durationMs ?? 45_000,
    width: options.width ?? 1_080,
    height: options.height ?? 1_920,
  };
  const recorded: { request?: JsonObject; response?: JsonObject } = {};
  const controller = new AbortController();
  return {
    platform,
    dryRun: options.dryRun ?? false,
    token,
    request,
    recorded,
    post: {
      id: postId,
      itemId: randomUUID(),
      versionId: randomUUID(),
      scheduledAt: new Date("2026-10-13T10:00:00Z"),
      attempt: 1,
      attemptStartedAt: new Date("2026-10-13T10:00:00Z"),
      externalId: options.externalId ?? null,
      externalContainerId: options.externalContainerId ?? null,
      options: {},
    },
    channel: {
      id: randomUUID(),
      platform,
      displayName: `${platform} channel`,
      externalId: accountId,
      username: null,
      parentChannelId: null,
      scopes: [],
      meta: {},
    },
    media: {
      format: "reel",
      video: {
        assetId: randomUUID(),
        sha256: "0".repeat(64),
        durationMs: request.durationMs,
        width: request.width,
        height: request.height,
        bytes: options.bytes ?? 9 * 1_048_576,
        mime: "video/mp4",
      },
      items: [],
      posterAssetId: null,
    },
    async secrets() {
      if (options.unreadableSecrets === true) {
        throw PublishFailure.of("auth", "The channel's credentials could not be decrypted.", {
          retryable: false,
        });
      }
      return { accessToken: token };
    },
    async getPublicVideoUrl() {
      return request.videoUrl;
    },
    async getPublicItemUrls() {
      return [];
    },
    async getPublicPosterUrl() {
      return null;
    },
    caption: () => caption,
    async publishRequest() {
      return request;
    },
    record(part) {
      if (part.request !== undefined) recorded.request = part.request;
      if (part.response !== undefined) recorded.response = part.response;
    },
    signal: controller.signal,
    logger: silentLogger,
    now: () => new Date("2026-10-13T10:00:00Z"),
  };
}

/**
 * What the dry-run adapter records for the post of `context`, beside what the live adapter
 * recorded once redacted: the two must match.
 */
export async function dryRunParity(
  context: FakeContext,
): Promise<{ dryRun: JsonObject | undefined; live: JsonObject | undefined }> {
  const dry: FakeContext = { ...context, dryRun: true, recorded: {} } as FakeContext;
  const recorded: { request?: JsonObject } = {};
  const adapter: PublisherAdapter = createDryRunAdapter(context.platform);
  await adapter.publish({
    ...dry,
    record(part) {
      if (part.request !== undefined) recorded.request = part.request;
    },
  });
  return {
    dryRun: recorded.request,
    live:
      context.recorded.request === undefined ? undefined : redactRequest(context.recorded.request),
  };
}
