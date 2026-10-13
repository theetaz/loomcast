import type { Platform, PostStatus } from "@loomcast/contracts";
import type { StatusTone } from "@loomcast/ui/components/StatusPill";
import { cn } from "@loomcast/ui/lib/cn";

// Post states, drawn like `StatusPill`. `StatusPill` gains a `post` kind with these tones in the
// channels work; until then the calendar keeps its own mapping here.

const POST_STATUS_STYLES: Record<PostStatus, { label: string; tone: StatusTone }> = {
  planned: { label: "Planned", tone: "gray" },
  queued: { label: "Queued", tone: "blue" },
  publishing: { label: "Publishing", tone: "violet" },
  published: { label: "Published", tone: "green" },
  failed: { label: "Failed", tone: "red" },
  cancelled: { label: "Cancelled", tone: "gray" },
  missed: { label: "Missed", tone: "red" },
};

// Full class names so Tailwind can find them.
const toneClassNames: Record<StatusTone, string> = {
  gray: "bg-status-gray/11 text-status-gray",
  amber: "bg-status-amber/11 text-status-amber",
  violet: "bg-status-violet/11 text-status-violet",
  blue: "bg-status-blue/11 text-status-blue",
  green: "bg-status-green/11 text-status-green",
  red: "bg-status-red/11 text-status-red",
};

const toneDotClassNames: Record<StatusTone, string> = {
  gray: "bg-status-gray",
  amber: "bg-status-amber",
  violet: "bg-status-violet",
  blue: "bg-status-blue",
  green: "bg-status-green",
  red: "bg-status-red",
};

export function postStatusStyle(status: PostStatus) {
  return POST_STATUS_STYLES[status] ?? { label: status, tone: "gray" as const };
}

export function PostStatusPill({ status, className }: { status: PostStatus; className?: string }) {
  const { label, tone } = postStatusStyle(status);
  return (
    <span
      data-slot="status-pill"
      data-kind="post"
      data-status={status}
      data-tone={tone}
      className={cn(
        "inline-flex h-[18px] shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-1.5 font-medium text-[11px]",
        "before:size-1.5 before:shrink-0 before:rounded-full before:bg-current before:content-['']",
        toneClassNames[tone],
        className,
      )}
    >
      {label}
    </span>
  );
}

export function PostStatusDot({ status }: { status: PostStatus }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        toneDotClassNames[postStatusStyle(status).tone],
      )}
    />
  );
}

// Platform colours mark channels; they are not brand tokens (as in the sidebar's channel list).
const PLATFORMS: Record<Platform, { label: string; color: string }> = {
  facebook: { label: "Facebook", color: "#1877f2" },
  instagram: { label: "Instagram", color: "#e1306c" },
  threads: { label: "Threads", color: "var(--foreground)" },
  x: { label: "X", color: "var(--color-text-2)" },
};

export function platformLabel(platform: Platform): string {
  return PLATFORMS[platform]?.label ?? platform;
}

export function PlatformDot({ platform, className }: { platform: Platform; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn("size-[7px] shrink-0 rounded-full", className)}
      style={{ background: PLATFORMS[platform]?.color ?? "var(--color-text-2)" }}
    />
  );
}
