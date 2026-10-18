import {
  PLATFORM_LABELS,
  type Platform,
  POST_FORMAT_LABELS,
  type PublishRequest,
  type VideoPublishRequest,
} from "@loomcast/contracts";

// The request builders are pure: given a `PublishRequest` and the credentials, they return the
// exact HTTP requests a platform receives. The live adapters send what they build; the dry-run
// adapter records the same output with the credentials redacted, so a dry run shows precisely
// what a live run would send.

/**
 * The API a request goes to. Paths carry no API version: the adapter's HTTP client resolves the
 * base URL (with the version it targets) through `resolveRequestUrl`.
 * - `graph`: the Graph API (`https://graph.facebook.com/<version>`).
 * - `rupload`: the Graph API video upload host (`https://rupload.facebook.com/video-upload/<version>`).
 * - `threads`: the Threads API (`https://graph.threads.net/<version>`).
 * - `x`: the X API (`https://api.x.com`); its paths start with `/2/`.
 */
export const PLATFORM_APIS = ["graph", "rupload", "threads", "x"] as const;
export type PlatformApi = (typeof PLATFORM_APIS)[number];

export type RequestFieldValue = string | number | boolean | readonly string[] | RequestFields;
export interface RequestFields {
  readonly [key: string]: RequestFieldValue;
}

/** One HTTP request to a platform. */
export interface PlatformRequest {
  /** Stable name of the step, such as `create_container`. */
  step: string;
  method: "GET" | "POST";
  api: PlatformApi;
  /** Path without the API version, such as `/17841400000000000/media`. */
  path: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: RequestFields;
  /** How `body` is sent. */
  bodyEncoding?: "json" | "form";
}

/**
 * The requests an adapter's `publish` sends, in order. Ids the platform returns in an earlier step
 * appear as `PLACEHOLDERS` in later ones; `pending: true` means the post then waits for the
 * platform to finish processing (`post.check_status`).
 */
export interface PublishPlan {
  platform: Platform;
  steps: PlatformRequest[];
  pending: boolean;
}

/** Stand-ins for ids the platform returns during a publish. */
export const PLACEHOLDERS = {
  containerId: "{container-id}",
  videoId: "{video-id}",
  mediaId: "{media-id}",
  /** A Facebook Page post (`{page-id}_{post-id}`) or a story post. */
  postId: "{post-id}",
  /** A Facebook photo uploaded on its own; `photoPlaceholder` numbers those of a multi-photo post. */
  photoId: "{photo-id}",
  segmentIndex: "{segment-index}",
} as const;

/** The placeholder of the `index`th (from 0) photo of a multi-photo post: `{photo-id-1}`, ... */
export function photoPlaceholder(index: number): string {
  return `{photo-id-${index + 1}}`;
}

/** The account id a request shows for a channel that is not connected yet (dry-run only). */
export const UNCONNECTED_ACCOUNT_ID = "{account-id}";

/** What a builder needs besides the `PublishRequest`. */
export interface BuildOptions {
  /** The channel's access token. The dry-run adapter passes `REDACTED`. */
  accessToken: string;
}

/** The size and type of the video, for platforms that upload bytes (X). */
export interface MediaFacts {
  bytes: number;
  mime: string;
}

/** Input of a publish plan: the request, credentials and, for a video post, the video's facts. */
export interface PlanInput extends BuildOptions {
  request: PublishRequest;
  media: MediaFacts | null;
}

/** Input of a video post's plan. */
export interface VideoPlanInput extends BuildOptions {
  request: VideoPublishRequest;
  media: MediaFacts;
}

/** Whether `request` is a `reel` or `video` post. */
export function isVideoRequest(request: PublishRequest): request is VideoPublishRequest {
  return request.format === "reel" || request.format === "video";
}

/** The message for a format a platform does not publish. */
export function unsupportedFormatMessage(platform: Platform, request: PublishRequest): string {
  return `${PLATFORM_LABELS[platform]} does not publish ${POST_FORMAT_LABELS[request.format].toLowerCase()}s.`;
}

/**
 * `input` as a video post's input. Throws for any other format: callers validate first
 * (`validatePublishRequest`), so reaching a builder with another format is a bug.
 */
export function videoPlanInput(input: PlanInput): VideoPlanInput {
  if (!isVideoRequest(input.request) || input.media === null) {
    throw new Error(unsupportedFormatMessage(input.request.platform, input.request));
  }
  return { ...input, request: input.request, media: input.media };
}

/**
 * The format check of a platform that publishes video posts only, followed by `check` for a
 * video post.
 */
export function videoOnlyIssues(
  request: PublishRequest,
  media: MediaFacts | null,
  check: (request: VideoPublishRequest, media: MediaFacts) => RequestIssue[],
): RequestIssue[] {
  if (!isVideoRequest(request)) {
    return [{ field: "format", message: unsupportedFormatMessage(request.platform, request) }];
  }
  if (media === null) {
    return [{ field: "video", message: "The post has no video." }];
  }
  return check(request, media);
}

/** A problem with a request a platform would refuse. */
export interface RequestIssue {
  /** Where: `format`, `video`, `media.<n>`, `duration`, `dimensions`, `size`, `caption`. */
  field: string;
  message: string;
}

/** Base URLs per API, with the version included, for `resolveRequestUrl`. */
export type ApiBaseUrls = Readonly<Record<PlatformApi, string>>;

/** The full URL of `request`: the API base, the path and the query string. */
export function resolveRequestUrl(request: PlatformRequest, bases: ApiBaseUrls): string {
  const url = new URL(`${bases[request.api].replace(/\/+$/, "")}${request.path}`);
  for (const [key, value] of Object.entries(request.query ?? {})) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

/** The `Authorization` value for a bearer token. */
export function bearer(accessToken: string): string {
  return `Bearer ${accessToken}`;
}

/** Path segment of an id; ids come from the platform or from `PLACEHOLDERS`. */
export function segment(id: string): string {
  return encodeURIComponent(id).replace(/%7B/g, "{").replace(/%7D/g, "}");
}

/** Checks shared by every platform: duration, dimensions and size bounds. */
export function checkMedia(
  request: Pick<VideoPublishRequest, "durationMs" | "width" | "height">,
  media: MediaFacts,
  limits: {
    minDurationMs: number;
    maxDurationMs: number;
    maxBytes: number;
    maxWidth?: number;
    minWidth?: number;
    minHeight?: number;
    minAspect?: number;
    maxAspect?: number;
    mimes: readonly string[];
  },
): RequestIssue[] {
  const issues: RequestIssue[] = [];
  const seconds = (ms: number) => `${Math.round(ms / 100) / 10} s`;
  if (!limits.mimes.includes(media.mime)) {
    issues.push({ field: "video", message: `The video type ${media.mime} is not accepted.` });
  }
  if (request.durationMs < limits.minDurationMs || request.durationMs > limits.maxDurationMs) {
    issues.push({
      field: "duration",
      message: `The video runs ${seconds(request.durationMs)}; it must run ${seconds(limits.minDurationMs)} to ${seconds(limits.maxDurationMs)}.`,
    });
  }
  if (media.bytes > limits.maxBytes) {
    issues.push({
      field: "size",
      message: `The video is larger than ${Math.floor(limits.maxBytes / 1_048_576)} MB.`,
    });
  }
  if (limits.maxWidth !== undefined && request.width > limits.maxWidth) {
    issues.push({
      field: "dimensions",
      message: `The video is wider than ${limits.maxWidth} pixels.`,
    });
  }
  if (
    (limits.minWidth !== undefined && request.width < limits.minWidth) ||
    (limits.minHeight !== undefined && request.height < limits.minHeight)
  ) {
    issues.push({
      field: "dimensions",
      message: `The video must be at least ${limits.minWidth ?? 1}×${limits.minHeight ?? 1} pixels.`,
    });
  }
  const aspect = request.width / request.height;
  if (
    (limits.minAspect !== undefined && aspect < limits.minAspect) ||
    (limits.maxAspect !== undefined && aspect > limits.maxAspect)
  ) {
    issues.push({ field: "dimensions", message: "The video's aspect ratio is not accepted." });
  }
  return issues;
}

export const MB = 1_048_576;
