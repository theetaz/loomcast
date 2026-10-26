import type { CompetitorScan, CompetitorScanVideo, Workspace } from "@loomcast/contracts";
import { Button } from "@loomcast/ui/components/button";
import { ScrollArea } from "@loomcast/ui/components/scroll-area";
import { Skeleton } from "@loomcast/ui/components/skeleton";
import { cn } from "@loomcast/ui/lib/cn";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  ExternalLinkIcon,
  FileTextIcon,
  OctagonXIcon,
  SearchXIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useEffect, useId, useRef } from "react";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { RelativeTime } from "@/components/RelativeTime";
import { formatCount, formatFullCount } from "@/features/analytics/format";
import { Markdown } from "@/features/conversation/Markdown";
import { kbEntryQueryOptions } from "@/features/kb/queries";
import { isApiError } from "@/lib/api";
import { useTitle } from "@/lib/use-title";
import { backLink } from "./CompetitorPage";
import { CancelScanDialog } from "./ConfirmDialogs";
import {
  competitorKeys,
  competitorQueryOptions,
  competitorScanQueryOptions,
  isActiveScan,
} from "./queries";
import {
  AnalysisStatusPill,
  analysedCount,
  competitorName,
  ScanStatusPill,
  SOURCE_LABELS,
} from "./status";

const CAPTION_EXCERPT = 90;

function excerpt(caption: string | null): string {
  if (!caption) return "";
  const flat = caption.replace(/\s+/g, " ").trim();
  return flat.length > CAPTION_EXCERPT ? `${flat.slice(0, CAPTION_EXCERPT - 1).trimEnd()}…` : flat;
}

/**
 * One scan: its progress while the studio agent works, the ranked videos with their analyses,
 * and the report once it is written. It asks again every few seconds while the scan is active.
 */
export function ScanPage({
  workspace,
  workspaceParam,
  competitorId,
  scanId,
}: {
  workspace: Workspace;
  workspaceParam: string;
  competitorId: string;
  scanId: string;
}) {
  const queryClient = useQueryClient();
  const competitor = useQuery(competitorQueryOptions(competitorId));
  const query = useQuery(competitorScanQueryOptions(scanId));
  const scan =
    query.data &&
    query.data.workspaceId === workspace.id &&
    query.data.competitorId === competitorId
      ? query.data
      : null;
  const name = competitor.data ? competitorName(competitor.data) : "Competitor";
  useTitle(`Scan of ${name} · ${workspace.name}`);

  // When the scan finishes, the competitor's summary and its scans list change too.
  const wasActive = useRef<boolean | null>(null);
  const active = scan ? isActiveScan(scan.status) : null;
  useEffect(() => {
    if (active === null) return;
    if (wasActive.current === true && !active) {
      void queryClient.invalidateQueries({ queryKey: competitorKeys.detail(competitorId) });
      void queryClient.invalidateQueries({ queryKey: competitorKeys.scans(competitorId) });
      void queryClient.invalidateQueries({ queryKey: competitorKeys.list(workspace.id) });
    }
    wasActive.current = active;
  }, [active, competitorId, workspace.id, queryClient]);

  const back = (
    <Link
      to="/w/$workspace/competitors/$competitorId"
      params={{ workspace: workspaceParam, competitorId }}
      className={backLink}
    >
      <ArrowLeftIcon aria-hidden="true" className="size-3.5" />
      {name}
    </Link>
  );

  if (query.isPending) {
    return (
      <div aria-hidden="true" className="flex flex-col gap-4">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-6 w-56" />
        <Skeleton className="h-64 rounded-lg" />
      </div>
    );
  }

  if (query.isError && !isApiError(query.error, 404)) {
    return (
      <div className="flex flex-col gap-4">
        {back}
        <ErrorState
          title="Couldn't load this scan"
          error={query.error}
          onRetry={() => void query.refetch()}
          retrying={query.isFetching}
        />
      </div>
    );
  }

  if (!scan) {
    return (
      <div className="flex flex-col gap-4">
        {back}
        <EmptyState
          icon={SearchXIcon}
          title="Scan not found"
          description="It may have been removed with its competitor, or the link points somewhere else."
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {back}
      <ScanHeader scan={scan} name={name} />
      {scan.error ? <ScanError scan={scan} /> : null}
      {scan.reportEntryId ? (
        <ReportPreview entryId={scan.reportEntryId} workspaceParam={workspaceParam} />
      ) : null}
      <VideosTable scan={scan} workspaceParam={workspaceParam} />
    </div>
  );
}

function ScanHeader({ scan, name }: { scan: CompetitorScan; name: string }) {
  const active = isActiveScan(scan.status);
  const done = analysedCount(scan);
  const total = scan.videos.length;
  return (
    <header className="flex flex-col gap-3 sm:flex-row sm:items-start">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <h1 className="flex flex-wrap items-center gap-2 text-title">
          <span className="min-w-0 break-words">Scan of {name}</span>
          <ScanStatusPill status={scan.status} />
        </h1>
        <p className="text-small text-muted-foreground">
          {SOURCE_LABELS[scan.source]} · Started{" "}
          <RelativeTime value={scan.createdAt} format="relative" />
          {scan.finishedAt ? (
            <>
              {" "}
              · Finished <RelativeTime value={scan.finishedAt} format="relative" />
            </>
          ) : null}
        </p>
        {active ? (
          <div className="mt-1 flex max-w-sm flex-col gap-1">
            <p role="status" className="text-control text-foreground">
              {scan.status === "reporting" ? "Writing the report…" : `${done} of ${total} analysed`}
            </p>
            <div
              aria-hidden="true"
              className="h-1 overflow-hidden rounded-full bg-secondary shadow-[0_0_0_1px_var(--border)]"
            >
              <div
                className="h-full origin-left rounded-full bg-status-violet transition-transform duration-300 ease-out motion-reduce:transition-none"
                style={{ transform: `scaleX(${total ? done / total : 0})` }}
              />
            </div>
          </div>
        ) : null}
      </div>
      {active ? (
        <CancelScanDialog scan={scan}>
          <Button variant="outline" className="self-start">
            <OctagonXIcon aria-hidden="true" />
            Cancel scan
          </Button>
        </CancelScanDialog>
      ) : null}
    </header>
  );
}

function ScanError({ scan }: { scan: CompetitorScan }) {
  return (
    <div
      role="alert"
      className="flex items-start gap-2.5 rounded-lg bg-status-red/8 px-3.5 py-3 text-control"
    >
      <TriangleAlertIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-status-red" />
      <div className="flex min-w-0 flex-col gap-0.5">
        <p className="font-medium text-foreground">
          {scan.status === "failed" ? "The scan failed" : "Some videos couldn't be analysed"}
        </p>
        <p className="break-words text-muted-foreground">{scan.error?.message}</p>
      </div>
    </div>
  );
}

function ReportPreview({ entryId, workspaceParam }: { entryId: string; workspaceParam: string }) {
  const id = useId();
  const query = useQuery(kbEntryQueryOptions(entryId));
  return (
    <section
      aria-labelledby={`${id}-title`}
      className="flex flex-col gap-2 rounded-lg bg-card px-3.5 py-3 shadow-card"
    >
      <div className="flex items-center gap-2">
        <FileTextIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        <h3 id={`${id}-title`} className="min-w-0 flex-1 truncate font-medium text-body">
          {query.data?.title ?? "Report"}
        </h3>
        <Button asChild variant="outline" size="sm">
          <Link to="/w/$workspace/kb/$entryId" params={{ workspace: workspaceParam, entryId }}>
            Open report
          </Link>
        </Button>
      </div>
      {query.data?.bodyMd ? (
        <div className="relative max-h-56 overflow-hidden">
          <Markdown text={query.data.bodyMd} />
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-card"
          />
        </div>
      ) : query.isPending ? (
        <div aria-hidden="true" className="flex flex-col gap-1.5">
          <Skeleton className="h-3 w-3/4" />
          <Skeleton className="h-3 w-1/2" />
        </div>
      ) : null}
    </section>
  );
}

const linkClass = cn(
  "rounded-sm outline-none underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-ring",
);

function VideosTable({ scan, workspaceParam }: { scan: CompetitorScan; workspaceParam: string }) {
  const videos = [...scan.videos].sort((a, b) => a.rank - b.rank);
  return (
    <ScrollArea
      role="region"
      aria-label="Videos"
      orientation="horizontal"
      className="rounded-lg bg-card shadow-card"
    >
      {videos.length === 0 ? (
        <EmptyState size="compact" icon={SearchXIcon} title="No videos in this scan" />
      ) : (
        <table className="w-full min-w-[640px] border-collapse text-left">
          <caption className="sr-only">Videos of the scan, most popular first</caption>
          <thead>
            <tr className="h-8 border-divider border-b text-small text-muted-foreground">
              <th scope="col" className="w-10 pl-3.5 font-medium">
                #
              </th>
              <th scope="col" className="px-2 font-medium">
                Video
              </th>
              <th scope="col" className="w-16 px-2 text-right font-medium">
                Views
              </th>
              <th scope="col" className="w-16 px-2 text-right font-medium">
                Likes
              </th>
              <th scope="col" className="w-20 px-2 text-right font-medium">
                Comments
              </th>
              <th scope="col" className="w-20 px-2 font-medium">
                Posted
              </th>
              <th scope="col" className="w-28 px-2 pr-3.5 font-medium">
                Analysis
              </th>
            </tr>
          </thead>
          <tbody>
            {videos.map((video) => (
              <VideoRow key={video.entryId} video={video} workspaceParam={workspaceParam} />
            ))}
          </tbody>
        </table>
      )}
    </ScrollArea>
  );
}

function Count({ value }: { value: number | null }) {
  return (
    <span title={value === null ? undefined : formatFullCount(value)}>{formatCount(value)}</span>
  );
}

function VideoRow({
  video,
  workspaceParam,
}: {
  video: CompetitorScanVideo;
  workspaceParam: string;
}) {
  const caption = excerpt(video.caption);
  return (
    <tr className="border-divider border-t text-control first:border-t-0">
      <td className="py-2 pl-3.5 font-mono text-[12px] text-muted-foreground tabular-nums">
        {video.rank}
      </td>
      <td className="max-w-0 px-2 py-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <Link
            to="/w/$workspace/kb/$entryId"
            params={{ workspace: workspaceParam, entryId: video.entryId }}
            className={cn(linkClass, "truncate text-foreground")}
            title={video.caption ?? undefined}
          >
            {caption || "Untitled video"}
          </Link>
          <a
            href={video.url}
            target="_blank"
            rel="noopener noreferrer"
            className={cn(
              linkClass,
              "inline-flex w-fit max-w-full items-center gap-1 text-[11.5px] text-muted-foreground",
            )}
          >
            <span className="truncate">Original video</span>
            <ExternalLinkIcon aria-hidden="true" className="size-3 shrink-0" />
            <span className="sr-only">(opens in a new tab)</span>
          </a>
        </div>
      </td>
      <td className="px-2 py-2 text-right tabular-nums">
        <Count value={video.metrics.views} />
      </td>
      <td className="px-2 py-2 text-right tabular-nums">
        <Count value={video.metrics.likes} />
      </td>
      <td className="px-2 py-2 text-right tabular-nums">
        <Count value={video.metrics.comments} />
      </td>
      <td className="px-2 py-2 text-muted-foreground">
        {video.metrics.postedAt ? (
          <RelativeTime value={video.metrics.postedAt} />
        ) : (
          <span title="The platform did not say">—</span>
        )}
      </td>
      <td className="px-2 py-2 pr-3.5">
        <AnalysisStatusPill status={video.analysisStatus} />
      </td>
    </tr>
  );
}
