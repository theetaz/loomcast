import type { Platform } from "@loomcast/contracts";
import type { PublisherAdapter } from "../types";
import { facebookAdapter } from "./facebook";
import { instagramAdapter } from "./instagram";
import { threadsAdapter } from "./threads";
import { isXPublishingEnabled, type XPlatforms, xAdapter } from "./x";

// The publisher adapters registry: one live adapter per platform, each in its own directory, so
// the platform adapters are added by replacing their own `index.ts` without touching this file.

export type AdapterRegistry = { readonly [P in Platform]: PublisherAdapter };

/** The live adapters. A post in dry-run never reaches them (see `createDryRunAdapter`). */
export const publisherAdapters: AdapterRegistry = Object.freeze({
  instagram: instagramAdapter,
  facebook: facebookAdapter,
  threads: threadsAdapter,
  x: xAdapter,
});

/**
 * Platforms whose channels may leave dry-run under the server's `platforms` settings. X is
 * available only while `FEATURE_X_PUBLISHING` is on and its client credentials are set.
 */
export function isLivePlatformAvailable(platform: Platform, platforms: XPlatforms): boolean {
  return platform !== "x" || isXPublishingEnabled(platforms);
}

export { createDryRunAdapter, DRY_RUN_MEDIA_ORIGIN, dryRunMediaUrl } from "./dry-run";
export { notConfiguredAdapter } from "./not-configured";
