import { cn } from "@loomcast/ui/lib/cn";
import type * as React from "react";

/**
 * Status colours from the brand prototype: gray waits, amber is being written or waits for a
 * person, violet is being produced, blue is queued for later, green is done and red failed.
 * Posts and channels follow the same rule: a missed post is red like a failed one, and a channel
 * that needs reconnecting waits for a person (amber).
 */
export type StatusTone = "gray" | "amber" | "violet" | "blue" | "green" | "red";

/**
 * A content item's pipeline state. Mirrors `PIPELINE_STATES` in `@loomcast/contracts`; the web
 * app's tests check that the two lists stay the same.
 */
export type PipelineStatus =
  | "idea"
  | "script"
  | "storyboard"
  | "voice"
  | "render"
  | "review"
  | "approved"
  | "scheduled"
  | "published"
  | "archived";

export type JobStatus = "queued" | "dispatched" | "running" | "succeeded" | "failed" | "cancelled";

export type DeviceStatus = "online" | "offline";

/** A scheduled post's status. Mirrors `POST_STATUSES` in `@loomcast/contracts`. */
export type PostStatus =
  | "planned"
  | "queued"
  | "publishing"
  | "published"
  | "failed"
  | "cancelled"
  | "missed";

/** A publishing channel's status. Mirrors `CHANNEL_STATUSES` in `@loomcast/contracts`. */
export type ChannelStatus = "active" | "needs_reauth" | "disconnected" | "disabled";

type StatusEntry = { label: string; tone: StatusTone };

export const STATUS_STYLES = {
  pipeline: {
    idea: { label: "Idea", tone: "gray" },
    script: { label: "Script", tone: "amber" },
    storyboard: { label: "Storyboard", tone: "amber" },
    voice: { label: "Voice", tone: "violet" },
    render: { label: "Render", tone: "violet" },
    review: { label: "In review", tone: "amber" },
    approved: { label: "Approved", tone: "green" },
    scheduled: { label: "Scheduled", tone: "blue" },
    published: { label: "Published", tone: "green" },
    archived: { label: "Archived", tone: "gray" },
  },
  job: {
    queued: { label: "Queued", tone: "gray" },
    dispatched: { label: "Dispatched", tone: "blue" },
    running: { label: "Running", tone: "violet" },
    succeeded: { label: "Succeeded", tone: "green" },
    failed: { label: "Failed", tone: "red" },
    cancelled: { label: "Cancelled", tone: "gray" },
  },
  device: {
    online: { label: "Online", tone: "green" },
    offline: { label: "Offline", tone: "gray" },
  },
  post: {
    planned: { label: "Planned", tone: "gray" },
    queued: { label: "Queued", tone: "blue" },
    publishing: { label: "Publishing", tone: "violet" },
    published: { label: "Published", tone: "green" },
    failed: { label: "Failed", tone: "red" },
    cancelled: { label: "Cancelled", tone: "gray" },
    missed: { label: "Missed", tone: "red" },
  },
  channel: {
    active: { label: "Active", tone: "green" },
    needs_reauth: { label: "Needs reconnect", tone: "amber" },
    disconnected: { label: "Not connected", tone: "gray" },
    disabled: { label: "Disabled", tone: "gray" },
  },
} as const satisfies {
  pipeline: Record<PipelineStatus, StatusEntry>;
  job: Record<JobStatus, StatusEntry>;
  device: Record<DeviceStatus, StatusEntry>;
  post: Record<PostStatus, StatusEntry>;
  channel: Record<ChannelStatus, StatusEntry>;
};

/** Every status a pill can show, of any kind. */
export type AnyStatus = PipelineStatus | JobStatus | DeviceStatus | PostStatus | ChannelStatus;

// Full class names so Tailwind can find them: text in the tone, an 11% wash behind it.
const toneClassNames: Record<StatusTone, string> = {
  gray: "bg-status-gray/11 text-status-gray",
  amber: "bg-status-amber/11 text-status-amber",
  violet: "bg-status-violet/11 text-status-violet",
  blue: "bg-status-blue/11 text-status-blue",
  green: "bg-status-green/11 text-status-green",
  red: "bg-status-red/11 text-status-red",
};

export type StatusPillProps = Omit<React.ComponentProps<"span">, "children"> & {
  /** Overrides the default label, for example to add a count. */
  children?: React.ReactNode;
} & (
    | { kind: "pipeline"; status: PipelineStatus }
    | { kind: "job"; status: JobStatus }
    | { kind: "device"; status: DeviceStatus }
    | { kind: "post"; status: PostStatus }
    | { kind: "channel"; status: ChannelStatus }
  );

export function statusStyle(kind: StatusPillProps["kind"], status: AnyStatus): StatusEntry {
  const entries: Record<string, StatusEntry> = STATUS_STYLES[kind];
  // A status newer than this package still renders, in the neutral tone.
  return entries[status] ?? { label: status, tone: "gray" };
}

export function StatusPill({ kind, status, className, children, ...props }: StatusPillProps) {
  const { label, tone } = statusStyle(kind, status);

  return (
    <span
      data-slot="status-pill"
      data-kind={kind}
      data-status={status}
      data-tone={tone}
      className={cn(
        "inline-flex h-[21px] shrink-0 items-center gap-[5px] whitespace-nowrap rounded-full px-[7px] font-medium text-[11.5px]",
        "before:size-1.5 before:shrink-0 before:rounded-full before:bg-current before:content-['']",
        toneClassNames[tone],
        className,
      )}
      {...props}
    >
      {children ?? label}
    </span>
  );
}

const toneDotClassNames: Record<StatusTone, string> = {
  gray: "bg-status-gray",
  amber: "bg-status-amber",
  violet: "bg-status-violet",
  blue: "bg-status-blue",
  green: "bg-status-green",
  red: "bg-status-red",
};

export type StatusDotProps = Omit<React.ComponentProps<"span">, "children"> &
  Pick<StatusPillProps, "kind" | "status">;

/**
 * The pill's dot on its own, for rows too dense for a label. It is decorative: say the status in
 * the row's accessible name.
 */
export function StatusDot({ kind, status, className, ...props }: StatusDotProps) {
  const { tone } = statusStyle(kind, status);
  return (
    <span
      aria-hidden="true"
      data-slot="status-dot"
      data-kind={kind}
      data-status={status}
      data-tone={tone}
      className={cn("size-1.5 shrink-0 rounded-full", toneDotClassNames[tone], className)}
      {...props}
    />
  );
}
