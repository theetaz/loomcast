import { DEFAULT_X_API_BASE_URL, type PlatformsConfig, type XAppConfig } from "../../../../env";
import type { FetchLike } from "../../../../lib/meta-graph";
import { createXClient, type XClient, type XClientOptions } from "./client";

// The X settings the sign-in, the token refresh and the adapter read. X is usable only when the
// feature flag is on and the app's client credentials are set; otherwise nothing builds a request.

/** The part of the platform settings that concerns X. */
export type XPlatforms = Pick<PlatformsConfig, "xPublishing" | "x" | "xApiBaseUrl">;

/** Settings with X off, for the registry's default adapter. */
export const X_DISABLED: XPlatforms = Object.freeze({ xPublishing: false, x: null });

/** The X app when `FEATURE_X_PUBLISHING` is on and the client credentials are set, else null. */
export function usableXApp(platforms: XPlatforms): XAppConfig | null {
  return platforms.xPublishing === true ? (platforms.x ?? null) : null;
}

/** Whether X publishing is on and configured. */
export function isXPublishingEnabled(platforms: XPlatforms): boolean {
  return usableXApp(platforms) !== null;
}

/** An X API client on the configured host. */
export function xClientFor(
  platforms: XPlatforms,
  options: Omit<XClientOptions, "baseUrl"> & { fetch?: FetchLike | undefined } = {},
): XClient {
  const { fetch, ...rest } = options;
  return createXClient({
    ...rest,
    ...(fetch === undefined ? {} : { fetch }),
    baseUrl: platforms.xApiBaseUrl ?? DEFAULT_X_API_BASE_URL,
  });
}
