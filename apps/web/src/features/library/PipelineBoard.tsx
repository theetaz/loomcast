import type { ContentItem, PipelineState } from "@loomcast/contracts";
import { StatusPill, statusStyle } from "@loomcast/ui/components/StatusPill";
import { ScrollArea } from "@loomcast/ui/components/scroll-area";
import { cn } from "@loomcast/ui/lib/cn";
import { Link } from "@tanstack/react-router";
import { TriangleAlertIcon } from "lucide-react";
import type { ReactNode } from "react";
import { FormatIcon } from "@/features/post-formats/FormatBadge";
import { useWorkspaceParam } from "@/features/workspace/current";
import { formatDateTime } from "@/lib/format";
import { useNow } from "@/lib/use-now";
import { formatDuration, formatTargetDay, isOverdue } from "./format";
import { groupByState } from "./items";

export interface PipelineBoardProps {
  items: ContentItem[];
  /** The filtered states; every state but archived when empty. */
  states: PipelineState[];
  seriesName: (id: string) => string | undefined;
  actions?: (item: ContentItem) => ReactNode;
}

/**
 * The pipeline as columns, one per state. It is read-only: items move between columns through
 * production and review, never by dragging. Columns scroll sideways on narrow screens.
 */
export function PipelineBoard({ items, states, seriesName, actions }: PipelineBoardProps) {
  const now = useNow();
  const columns = groupByState(items, states);

  return (
    // Every card is a link, and a focused card scrolls into view, so the keyboard reaches all columns.
    <ScrollArea
      role="region"
      aria-label="Pipeline board"
      orientation="horizontal"
      viewportClassName="snap-x snap-mandatory scroll-px-3 sm:snap-none"
    >
      <ol className="flex w-max gap-2.5 p-3">
        {columns.map((column) => (
          <li
            key={column.state}
            aria-label={`${statusStyle("pipeline", column.state).label}, ${column.items.length} ${column.items.length === 1 ? "item" : "items"}`}
            data-state={column.state}
            className="flex w-[min(80vw,248px)] shrink-0 snap-start flex-col gap-2 rounded-lg bg-secondary/70 p-1.5"
          >
            <h3 className="flex h-7 items-center gap-2 px-1.5">
              <StatusPill kind="pipeline" status={column.state} />
              <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
                {column.items.length}
              </span>
            </h3>
            {column.items.length > 0 ? (
              <ul className="flex flex-col gap-1.5">
                {column.items.map((item) => (
                  <BoardCard
                    key={item.id}
                    item={item}
                    series={item.seriesId ? seriesName(item.seriesId) : undefined}
                    now={now}
                    actions={actions?.(item)}
                  />
                ))}
              </ul>
            ) : (
              <p className="flex h-14 items-center justify-center rounded-md border border-border border-dashed text-small text-text-4">
                Nothing here
              </p>
            )}
          </li>
        ))}
      </ol>
    </ScrollArea>
  );
}

function BoardCard({
  item,
  series,
  now,
  actions,
}: {
  item: ContentItem;
  series: string | undefined;
  now: number;
  actions: ReactNode;
}) {
  const workspaceParam = useWorkspaceParam();
  const overdue =
    item.targetAt !== null &&
    item.state !== "published" &&
    item.state !== "archived" &&
    isOverdue(item.targetAt, now);

  return (
    <li
      data-item-id={item.id}
      className={cn(
        "relative flex flex-col gap-1.5 rounded-md bg-card px-2.5 pt-2 pb-2.5 shadow-card",
        "has-[a:focus-visible]:ring-2 has-[a:focus-visible]:ring-ring",
      )}
    >
      <Link
        to="/w/$workspace/content/$itemId"
        params={{ workspace: workspaceParam, itemId: item.id }}
        className="line-clamp-2 pr-6 font-medium text-[13px] text-foreground leading-snug outline-none after:absolute after:inset-0 after:rounded-md after:content-['']"
      >
        {item.title}
      </Link>
      <div className="flex min-w-0 items-center gap-1.5 text-small text-muted-foreground">
        {item.lastError ? (
          <span title={item.lastError.message} className="inline-flex shrink-0 text-status-red">
            <TriangleAlertIcon aria-hidden="true" className="size-3.5" />
            <span className="sr-only">Last step failed: {item.lastError.message}</span>
          </span>
        ) : null}
        <FormatIcon format={item.format} label />
        <span className="min-w-0 truncate">{series ?? "No series"}</span>
        <span className="ml-auto shrink-0 font-mono text-[11px]">v{item.versionNo}</span>
      </div>
      {item.targetAt || item.durationMs !== null ? (
        <div className="flex items-center gap-2 text-small">
          {item.targetAt ? (
            <time
              dateTime={item.targetAt}
              title={formatDateTime(item.targetAt)}
              className={cn("tabular-nums", overdue ? "text-status-red" : "text-text-2")}
            >
              {formatTargetDay(item.targetAt, now)}
              {overdue ? <span className="sr-only"> (passed)</span> : null}
            </time>
          ) : null}
          {item.durationMs !== null ? (
            <span className="ml-auto font-mono text-[11px] text-muted-foreground">
              {formatDuration(item.durationMs)}
            </span>
          ) : null}
        </div>
      ) : null}
      {actions ? <div className="absolute top-1.5 right-1.5 z-10">{actions}</div> : null}
    </li>
  );
}
