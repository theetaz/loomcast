import type {
  CompetitorPlatform,
  CompetitorScan,
  CompetitorScanSource,
  CompetitorScanStatus,
  ReferenceAnalysisStatus,
} from "@loomcast/contracts";
import type { StatusTone } from "@loomcast/ui/components/StatusPill";
import { cn } from "@loomcast/ui/lib/cn";
import { formatCount } from "@/features/analytics/format";
import { platformLabel } from "@/features/channels/platforms";

// Status pills for scans and their videos, in the tones of the shared status pill: violet while
// the studio agent works, green when done, amber when only part of it worked, red when it failed.

const toneClassNames: Record<StatusTone, string> = {
  gray: "bg-status-gray/11 text-status-gray",
  amber: "bg-status-amber/11 text-status-amber",
  violet: "bg-status-violet/11 text-status-violet",
  blue: "bg-status-blue/11 text-status-blue",
  green: "bg-status-green/11 text-status-green",
  red: "bg-status-red/11 text-status-red",
};

export const SCAN_STATUS: Record<CompetitorScanStatus, { label: string; tone: StatusTone }> = {
  analyzing: { label: "Analyzing", tone: "violet" },
  reporting: { label: "Writing report", tone: "violet" },
  done: { label: "Done", tone: "green" },
  partial: { label: "Partly done", tone: "amber" },
  failed: { label: "Failed", tone: "red" },
  cancelled: { label: "Cancelled", tone: "gray" },
};

export const ANALYSIS_STATUS: Record<ReferenceAnalysisStatus, { label: string; tone: StatusTone }> =
  {
    none: { label: "Not analyzed", tone: "gray" },
    queued: { label: "Queued", tone: "gray" },
    running: { label: "Analyzing", tone: "violet" },
    done: { label: "Analyzed", tone: "green" },
    failed: { label: "Failed", tone: "red" },
  };

function Pill({
  label,
  tone,
  status,
  className,
}: {
  label: string;
  tone: StatusTone;
  status: string;
  className?: string;
}) {
  return (
    <span
      data-slot="status-pill"
      data-status={status}
      data-tone={tone}
      className={cn(
        "inline-flex h-[21px] shrink-0 items-center gap-[5px] whitespace-nowrap rounded-full px-[7px] font-medium text-[11.5px]",
        "before:size-1.5 before:shrink-0 before:rounded-full before:bg-current before:content-['']",
        toneClassNames[tone],
        className,
      )}
    >
      {label}
    </span>
  );
}

export function ScanStatusPill({
  status,
  className,
}: {
  status: CompetitorScanStatus;
  className?: string;
}) {
  const meta = SCAN_STATUS[status] ?? { label: status, tone: "gray" };
  return <Pill label={meta.label} tone={meta.tone} status={status} className={className} />;
}

export function AnalysisStatusPill({ status }: { status: ReferenceAnalysisStatus }) {
  const meta = ANALYSIS_STATUS[status] ?? { label: status, tone: "gray" };
  return <Pill label={meta.label} tone={meta.tone} status={status} />;
}

export const SOURCE_LABELS: Record<CompetitorScanSource, string> = {
  official_api: "Most viewed",
  links: "Pasted links",
};

/** `@handle` on Instagram and Threads; Facebook Pages are named without the `@`. */
export function competitorName(competitor: {
  platform: CompetitorPlatform;
  handle: string;
}): string {
  return competitor.platform === "facebook" ? competitor.handle : `@${competitor.handle}`;
}

/** "@handle (Instagram)", for accessible names. */
export function competitorLabel(competitor: {
  platform: CompetitorPlatform;
  handle: string;
}): string {
  return `${competitorName(competitor)} (${platformLabel(competitor.platform)})`;
}

/** Videos whose analysis has finished, well or not. */
export function analysedCount(scan: Pick<CompetitorScan, "videos">): number {
  return scan.videos.filter(
    (video) => video.analysisStatus === "done" || video.analysisStatus === "failed",
  ).length;
}

/** "248K followers · 412 posts", leaving out what the platform did not say. */
export function accountFacts(account: {
  followersCount: number | null;
  mediaCount: number | null;
}): string[] {
  const facts: string[] = [];
  if (account.followersCount !== null) {
    facts.push(
      `${formatCount(account.followersCount)} ${account.followersCount === 1 ? "follower" : "followers"}`,
    );
  }
  if (account.mediaCount !== null) {
    facts.push(`${formatCount(account.mediaCount)} ${account.mediaCount === 1 ? "post" : "posts"}`);
  }
  return facts;
}
