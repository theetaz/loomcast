import type { ContentVersionSummary, Review, VersionCreatedVia } from "@loomcast/contracts";
import { StatusPill } from "@loomcast/ui/components/StatusPill";
import { cn } from "@loomcast/ui/lib/cn";
import {
  AudioLinesIcon,
  FileTextIcon,
  FilmIcon,
  GitCompareArrowsIcon,
  LayoutPanelTopIcon,
  type LucideIcon,
} from "lucide-react";
import { RelativeTime } from "@/components/RelativeTime";

const AUTHORS: Record<VersionCreatedVia, string> = {
  ui: "Edited here",
  mcp: "From an MCP client",
  job: "By the studio agent",
  system: "Created",
};

const DECISIONS: Record<Review["decision"], { label: string; className: string }> = {
  approve: { label: "Approved", className: "text-status-green" },
  request_changes: { label: "Changes requested", className: "text-status-amber" },
  reject: { label: "Rejected", className: "text-status-red" },
};

function artifactsOf(version: ContentVersionSummary): { icon: LucideIcon; label: string }[] {
  return [
    version.hasScript && { icon: FileTextIcon, label: "Script" },
    version.hasStoryboard && { icon: LayoutPanelTopIcon, label: "Storyboard" },
    version.voiceAssetId && { icon: AudioLinesIcon, label: "Voice" },
    version.renderAssetId && { icon: FilmIcon, label: "Video" },
  ].filter((entry): entry is { icon: LucideIcon; label: string } => Boolean(entry));
}

/**
 * Every version, newest first: who made it, the stage it reached, its artifacts and any review of
 * it. Picking one shows it in the tabs; Compare opens the script diff against the one shown.
 */
export function VersionTimeline({
  versions,
  currentVersionId,
  viewedVersionId,
  reviews,
  onView,
  onCompare,
}: {
  versions: readonly ContentVersionSummary[];
  currentVersionId: string;
  viewedVersionId: string;
  reviews: readonly Review[];
  onView: (versionId: string) => void;
  onCompare: (versionId: string) => void;
}) {
  const viewed = versions.find((version) => version.id === viewedVersionId);

  return (
    <section aria-labelledby="versions-heading" className="rounded-lg bg-card shadow-card">
      <div className="flex h-11 items-center justify-between border-divider border-b px-4">
        <h2 id="versions-heading" className="font-semibold text-[13px]">
          Versions
        </h2>
        <span className="text-small text-muted-foreground">{versions.length}</span>
      </div>
      <ol className="flex max-h-[360px] flex-col overflow-y-auto overscroll-contain py-1">
        {versions.map((version) => {
          const current = version.id === currentVersionId;
          const shown = version.id === viewedVersionId;
          const decisions = reviews.filter((review) => review.versionId === version.id);
          const canCompare = !shown && version.hasScript && viewed?.hasScript === true;
          return (
            <li key={version.id} className="group/version relative">
              <div
                className={cn(
                  "flex items-start gap-2.5 px-4 py-2",
                  shown && "bg-accent-soft/60 dark:bg-accent-soft/30",
                )}
              >
                <button
                  type="button"
                  aria-current={shown ? "true" : undefined}
                  aria-label={`Show version ${version.versionNo}${current ? ", current" : ""}`}
                  onClick={() => onView(version.id)}
                  className="flex min-w-0 flex-1 flex-col items-start gap-1 rounded-sm text-left outline-none after:absolute after:inset-0 focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset"
                >
                  <span className="flex w-full items-center gap-2">
                    <span className="font-medium font-mono text-mono text-foreground">
                      v{version.versionNo}
                    </span>
                    <StatusPill kind="pipeline" status={version.stage} />
                    {current ? (
                      <span className="text-[11px] font-medium text-primary">Current</span>
                    ) : null}
                    <span className="ml-auto flex items-center gap-1 text-text-4">
                      {artifactsOf(version).map(({ icon: Icon, label }) => (
                        <Icon key={label} aria-label={label} className="size-3" />
                      ))}
                    </span>
                  </span>
                  <span className="text-small text-muted-foreground">
                    {AUTHORS[version.createdVia]} ·{" "}
                    <RelativeTime value={version.createdAt} format="relative" />
                  </span>
                  {version.notes ? (
                    <span className="line-clamp-2 text-small text-text-2">{version.notes}</span>
                  ) : null}
                  {decisions.map((review) => (
                    <span
                      key={review.id}
                      className={cn("text-small font-medium", DECISIONS[review.decision].className)}
                    >
                      {DECISIONS[review.decision].label}
                      {review.comment ? (
                        <span className="font-normal text-muted-foreground">
                          : {review.comment}
                        </span>
                      ) : null}
                    </span>
                  ))}
                </button>
                {canCompare ? (
                  <button
                    type="button"
                    onClick={() => onCompare(version.id)}
                    aria-label={`Compare the script of version ${version.versionNo}`}
                    title="Compare scripts"
                    className="relative z-10 flex size-6 shrink-0 items-center justify-center rounded-sm text-text-4 outline-none transition-colors hover:bg-foreground/6 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <GitCompareArrowsIcon aria-hidden="true" className="size-3.5" />
                  </button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
