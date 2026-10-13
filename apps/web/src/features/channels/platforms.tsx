import type { Platform } from "@loomcast/contracts";
import { cn } from "@loomcast/ui/lib/cn";

// Platform colours mark channels in the sidebar, the calendar and settings. They are not brand
// tokens, and no platform artwork is drawn: a channel shows a coloured dot or a lettered tile.

interface PlatformMeta {
  label: string;
  color: string;
  /** Text colour on a tile filled with `color`. */
  ink: string;
  /** The tile's letters. */
  mark: string;
}

export const PLATFORM_META: Record<Platform, PlatformMeta> = {
  facebook: { label: "Facebook", color: "#1877f2", ink: "#ffffff", mark: "f" },
  instagram: { label: "Instagram", color: "#e1306c", ink: "#ffffff", mark: "IG" },
  threads: { label: "Threads", color: "var(--foreground)", ink: "var(--background)", mark: "@" },
  x: { label: "X", color: "var(--color-text-2)", ink: "var(--background)", mark: "X" },
};

/** The platforms in the order the product lists them; X last, behind its feature flag. */
export const PLATFORM_ORDER: readonly Platform[] = ["facebook", "instagram", "threads", "x"];

/** Channels by platform in the product's order, then by name. */
export function sortChannels<
  T extends { platform: Platform; displayName: string; createdAt: string },
>(channels: readonly T[]): T[] {
  return [...channels].sort(
    (a, b) =>
      PLATFORM_ORDER.indexOf(a.platform) - PLATFORM_ORDER.indexOf(b.platform) ||
      a.displayName.localeCompare(b.displayName) ||
      a.createdAt.localeCompare(b.createdAt),
  );
}

export function platformLabel(platform: Platform): string {
  return PLATFORM_META[platform]?.label ?? platform;
}

/** "Display name (Platform)", for accessible names and lists that mix channels. */
export function channelLabel(channel: { displayName: string; platform: Platform }): string {
  return `${channel.displayName} (${platformLabel(channel.platform)})`;
}

export function PlatformDot({ platform, className }: { platform: Platform; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn("size-[7px] shrink-0 rounded-full", className)}
      style={{ background: PLATFORM_META[platform]?.color ?? "var(--color-text-2)" }}
    />
  );
}

/** A lettered tile in the platform's colour. Decorative: the row names the platform. */
export function PlatformTile({ platform, className }: { platform: Platform; className?: string }) {
  const meta = PLATFORM_META[platform];
  return (
    <span
      aria-hidden="true"
      data-platform={platform}
      className={cn(
        "flex size-7 shrink-0 select-none items-center justify-center rounded-md font-semibold text-[11.5px] leading-none tracking-[-0.02em]",
        className,
      )}
      style={{ background: meta?.color, color: meta?.ink }}
    >
      {meta?.mark ?? platform.slice(0, 2)}
    </span>
  );
}
