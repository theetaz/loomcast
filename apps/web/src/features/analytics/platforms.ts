import { PLATFORMS, type Platform } from "@loomcast/contracts";

export const PLATFORM_LABELS: Record<Platform, string> = {
  facebook: "Facebook",
  instagram: "Instagram",
  threads: "Threads",
  x: "X",
};

/**
 * Each platform keeps one categorical slot (`--viz-1` to `--viz-4` in `viz.css`) on every chart,
 * so its colour follows the platform and never its rank or the platforms on screen.
 */
export const PLATFORM_SLOT: Record<Platform, 1 | 2 | 3 | 4> = {
  facebook: 1,
  instagram: 2,
  threads: 3,
  x: 4,
};

export function platformColor(platform: Platform): string {
  return `var(--viz-${PLATFORM_SLOT[platform]})`;
}

/** Platforms in the fixed contract order, without duplicates. */
export function orderPlatforms(platforms: Iterable<Platform>): Platform[] {
  const present = new Set(platforms);
  return PLATFORMS.filter((platform) => present.has(platform));
}
