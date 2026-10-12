import { cn } from "@loomcast/ui/lib/cn";
import type * as React from "react";

/**
 * Status colours from the brand prototype: gray waits, amber is being written,
 * violet is being produced, blue is queued for later, green is done and red failed.
 */
export type StatusTone = "gray" | "amber" | "violet" | "blue" | "green" | "red";

export type PipelineStatus =
  | "idea"
  | "drafting"
  | "rendering"
  | "scheduled"
  | "published"
  | "failed";

export type JobStatus = "queued" | "dispatched" | "running" | "succeeded" | "failed" | "cancelled";

export type DeviceStatus = "online" | "offline";

type StatusEntry = { label: string; tone: StatusTone };

export const STATUS_STYLES = {
  pipeline: {
    idea: { label: "Idea", tone: "gray" },
    drafting: { label: "Drafting", tone: "amber" },
    rendering: { label: "Rendering", tone: "violet" },
    scheduled: { label: "Scheduled", tone: "blue" },
    published: { label: "Published", tone: "green" },
    failed: { label: "Failed", tone: "red" },
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
} as const satisfies {
  pipeline: Record<PipelineStatus, StatusEntry>;
  job: Record<JobStatus, StatusEntry>;
  device: Record<DeviceStatus, StatusEntry>;
};

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
  );

export function statusStyle(
  kind: StatusPillProps["kind"],
  status: PipelineStatus | JobStatus | DeviceStatus,
): StatusEntry {
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
