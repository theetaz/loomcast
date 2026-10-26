import type { ContentItem } from "@loomcast/contracts";
import { Button } from "@loomcast/ui/components/button";
import { Skeleton } from "@loomcast/ui/components/skeleton";
import { cn } from "@loomcast/ui/lib/cn";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ClipboardCheckIcon, TriangleAlertIcon } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { RelativeTime } from "@/components/RelativeTime";
import { formatDuration } from "@/features/library/format";
import { useSeriesOptions } from "@/features/library/queries";
import { formatLabel } from "@/features/post-formats/FormatBadge";
import { useWorkspaceParam } from "@/features/workspace/current";
import { formatDateTime } from "@/lib/format";
import { useNow } from "@/lib/use-now";
import { type DeadlineTone, deadlineOf } from "./deadline";
import { Poster } from "./Poster";
import { compareQueue, reviewQueueQueryOptions, useReviewQueueLive } from "./queries";
import { useQueueKeys } from "./use-queue-keys";

const ROW_LINK = "a[data-queue-link]";

const TONES: Record<DeadlineTone, string> = {
  red: "bg-status-red/11 text-status-red",
  amber: "bg-status-amber/11 text-status-amber",
  blue: "bg-status-blue/11 text-status-blue",
  gray: "bg-status-gray/11 text-status-gray",
};

/**
 * The workspace's videos waiting for a decision, the nearest publishing date first. `j` and `k`
 * move between them and Enter opens one; the item page holds the review actions.
 */
export function ReviewQueue({ workspaceId }: { workspaceId: string }) {
  useReviewQueueLive();
  const workspaceParam = useWorkspaceParam();
  const now = useNow();
  const query = useInfiniteQuery(reviewQueueQueryOptions(workspaceId));
  const { byId: seriesById } = useSeriesOptions(workspaceId);
  const listRef = useRef<HTMLOListElement>(null);
  const [activeId, setActiveId] = useState<string | null>(null);

  const items = useMemo(
    () => (query.data?.pages.flatMap((page) => page.items) ?? []).slice().sort(compareQueue),
    [query.data],
  );
  const activeIndex = Math.max(
    0,
    items.findIndex((item) => item.id === activeId),
  );
  useQueueKeys(listRef, ROW_LINK, activeIndex);

  const overdue = items.filter((item) => item.targetAt && Date.parse(item.targetAt) <= now).length;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {query.data ? (
          <p className="text-control text-muted-foreground" aria-live="polite">
            {items.length === 1 ? "1 video" : `${items.length} videos`}
            {query.hasNextPage ? " loaded" : ""}
            {overdue > 0 ? (
              <span className="text-status-red"> · {overdue} past their date</span>
            ) : null}
          </p>
        ) : null}
        <p className="ml-auto hidden text-small text-muted-foreground md:block">
          <kbd className="rounded-[4px] bg-secondary px-1 font-mono text-[11px] shadow-[0_0_0_1px_var(--border)]">
            j
          </kbd>{" "}
          <kbd className="rounded-[4px] bg-secondary px-1 font-mono text-[11px] shadow-[0_0_0_1px_var(--border)]">
            k
          </kbd>{" "}
          to move,{" "}
          <kbd className="rounded-[4px] bg-secondary px-1 font-mono text-[11px] shadow-[0_0_0_1px_var(--border)]">
            Enter
          </kbd>{" "}
          to open
        </p>
      </div>

      <section aria-label="Review queue" className="overflow-hidden rounded-lg bg-card shadow-card">
        {query.isPending ? (
          <QueueSkeleton />
        ) : query.isError ? (
          <ErrorState
            size="compact"
            title="Couldn't load the review queue"
            error={query.error}
            onRetry={() => void query.refetch()}
            retrying={query.isFetching}
          />
        ) : items.length === 0 ? (
          <EmptyState
            size="compact"
            icon={ClipboardCheckIcon}
            title="Nothing to review"
            description="Videos land here when they finish rendering and wait for your decision."
            action={
              <Button asChild variant="outline">
                <Link to="/w/$workspace/library" params={{ workspace: workspaceParam }}>
                  Open the library
                </Link>
              </Button>
            }
          />
        ) : (
          <ol ref={listRef} aria-label="Videos in review">
            {items.map((item, index) => (
              <QueueRow
                key={item.id}
                item={item}
                seriesName={item.seriesId ? (seriesById.get(item.seriesId)?.name ?? null) : null}
                tabbable={index === activeIndex}
                onFocus={() => setActiveId(item.id)}
                now={now}
              />
            ))}
          </ol>
        )}
        {query.hasNextPage ? (
          <div className="flex justify-center border-divider border-t px-3.5 py-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
            >
              {query.isFetchingNextPage ? "Loading…" : "Load more"}
            </Button>
          </div>
        ) : null}
      </section>
    </div>
  );
}

function QueueRow({
  item,
  seriesName,
  tabbable,
  onFocus,
  now,
}: {
  item: ContentItem;
  seriesName: string | null;
  tabbable: boolean;
  onFocus: () => void;
  now: number;
}) {
  const workspaceParam = useWorkspaceParam();
  const deadline = deadlineOf(item.targetAt, now);
  const context = seriesName ?? "";
  return (
    <li className="border-divider border-t first:border-t-0" data-item-id={item.id}>
      <Link
        to="/w/$workspace/content/$itemId"
        params={{ workspace: workspaceParam, itemId: item.id }}
        data-queue-link=""
        tabIndex={tabbable ? 0 : -1}
        onFocus={onFocus}
        className={cn(
          "flex min-h-[68px] items-center gap-3 px-3.5 py-2 outline-none transition-colors",
          "hover:bg-secondary focus-visible:bg-secondary focus-visible:shadow-[inset_2px_0_0_var(--ring)]",
        )}
      >
        <Poster assetId={item.posterAssetId} format={item.format} className="w-[30px]" />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate font-medium text-body text-foreground">{item.title}</span>
            {item.lastError ? (
              <span title={item.lastError.message} className="inline-flex shrink-0 text-status-red">
                <TriangleAlertIcon aria-hidden="true" className="size-3.5" />
                <span className="sr-only">Last step failed: {item.lastError.message}</span>
              </span>
            ) : null}
          </span>
          <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-small text-muted-foreground">
            {context ? <span className="min-w-0 truncate">{context}</span> : null}
            {context ? <span aria-hidden="true">·</span> : null}
            <span data-format={item.format}>{formatLabel(item.format)}</span>
            <span aria-hidden="true">·</span>
            <span className="font-mono text-[11px]">v{item.versionNo}</span>
            {item.durationMs !== null ? (
              <>
                <span aria-hidden="true">·</span>
                <span className="font-mono text-[11px]">{formatDuration(item.durationMs)}</span>
              </>
            ) : null}
            <span aria-hidden="true" className="hidden sm:inline">
              ·
            </span>
            <span className="hidden sm:inline">
              In review <RelativeTime value={item.updatedAt} format="relative" />
            </span>
          </span>
        </span>
        <span
          data-tone={deadline.tone}
          title={item.targetAt ? formatDateTime(item.targetAt) : undefined}
          className={cn(
            "inline-flex h-[21px] shrink-0 items-center whitespace-nowrap rounded-full px-[7px] font-medium text-[11.5px] tabular-nums",
            TONES[deadline.tone],
          )}
        >
          <span aria-hidden="true">{deadline.label}</span>
          <span className="sr-only">{deadline.description}</span>
        </span>
      </Link>
    </li>
  );
}

function QueueSkeleton() {
  return (
    <div aria-hidden="true">
      {["54%", "41%", "63%"].map((width) => (
        <div
          key={width}
          className="flex h-[68px] items-center gap-3 border-divider border-t px-3.5 first:border-t-0"
        >
          <Skeleton className="h-[53px] w-[30px] rounded-[5px]" />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-3" style={{ width }} />
            <Skeleton className="h-2.5 w-32" />
          </div>
          <Skeleton className="h-[18px] w-16 rounded-full" />
        </div>
      ))}
    </div>
  );
}
