import type { Platform } from "@loomcast/contracts";
import type { PublisherAdapter } from "../types";
import { facebookAdapter } from "./facebook";
import { instagramAdapter } from "./instagram";
import { threadsAdapter } from "./threads";
import { xAdapter } from "./x";

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
 * Platforms whose channels may leave dry-run. X stays unavailable until its adapter ships behind
 * its feature flag, which then decides here.
 */
export function isLivePlatformAvailable(platform: Platform): boolean {
  return platform !== "x";
}

export { createDryRunAdapter, DRY_RUN_MEDIA_ORIGIN, dryRunMediaUrl } from "./dry-run";
export { notConfiguredAdapter } from "./not-configured";
