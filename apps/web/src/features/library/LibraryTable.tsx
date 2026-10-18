import type { ContentItem } from "@loomcast/contracts";
import { StatusPill } from "@loomcast/ui/components/StatusPill";
import { Skeleton } from "@loomcast/ui/components/skeleton";
import { cn } from "@loomcast/ui/lib/cn";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowDownIcon, ArrowUpIcon, TriangleAlertIcon } from "lucide-react";
import { type KeyboardEvent, type MouseEvent, type ReactNode, useRef, useState } from "react";
import { RelativeTime } from "@/components/RelativeTime";
import { FormatIcon } from "@/features/post-formats/FormatBadge";
import { formatDateTime } from "@/lib/format";
import { useNow } from "@/lib/use-now";
import { formatDuration, formatTargetDay, isOverdue } from "./format";
import { type LibrarySort, type LibrarySortKey, parseSort } from "./search";

const COLUMNS: { key: LibrarySortKey; label: string; className: string }[] = [
  { key: "title", label: "Title", className: "" },
  { key: "series", label: "Series", className: "hidden w-[150px] md:table-cell" },
  { key: "state", label: "State", className: "w-[100px] sm:w-[108px]" },
  { key: "version", label: "Version", className: "hidden w-[68px] md:table-cell" },
  { key: "target", label: "Target", className: "hidden w-[84px] sm:table-cell" },
  { key: "duration", label: "Length", className: "hidden w-[64px] md:table-cell" },
  { key: "updated", label: "Updated", className: "w-[60px] sm:w-[88px]" },
];

/** States after which a passed target date is no longer a problem. */
const DONE_STATES = new Set(["published", "archived"]);

export interface LibraryTableProps {
  items: ContentItem[];
  sort: LibrarySort;
  onSortChange: (key: LibrarySortKey) => void;
  seriesName: (id: string) => string | undefined;
  /** A menu of quick actions for a row. */
  actions?: (item: ContentItem) => ReactNode;
}

/**
 * The library as a dense table. Column headers sort the loaded items. The title of one row is in
 * the tab order at a time: arrow keys, Home and End move between rows and Enter opens one.
 */
export function LibraryTable({
  items,
  sort,
  onSortChange,
  seriesName,
  actions,
}: LibraryTableProps) {
  const navigate = useNavigate();
  const now = useNow();
  const bodyRef = useRef<HTMLTableSectionElement>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const { key: sortKey, descending } = parseSort(sort);
  const activeIndex = Math.max(
    0,
    items.findIndex((item) => item.id === activeId),
  );

  const rowLinks = () =>
    Array.from(bodyRef.current?.querySelectorAll<HTMLAnchorElement>("a[data-row-link]") ?? []);

  const onKeyDown = (event: KeyboardEvent<HTMLTableSectionElement>) => {
    const links = rowLinks();
    const index = links.indexOf(event.target as HTMLAnchorElement);
    if (index < 0) return;
    let next: number | null = null;
    if (event.key === "ArrowDown") next = Math.min(links.length - 1, index + 1);
    else if (event.key === "ArrowUp") next = Math.max(0, index - 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = links.length - 1;
    if (next === null) return;
    event.preventDefault();
    links[next]?.focus();
  };

  const onRowClick = (event: MouseEvent<HTMLTableRowElement>, item: ContentItem) => {
    // Links, buttons and menus inside the row handle their own clicks.
    if ((event.target as HTMLElement).closest("a, button, [role=menu], [role=menuitem]")) return;
    if (window.getSelection()?.toString()) return;
    void navigate({ to: "/content/$itemId", params: { itemId: item.id } });
  };

  return (
    <table className="w-full table-fixed border-collapse text-left">
      <caption className="sr-only">
        Videos, sorted by {COLUMNS.find((column) => column.key === sortKey)?.label.toLowerCase()}
      </caption>
      <thead>
        <tr className="h-8 border-divider border-b text-small text-muted-foreground">
          {COLUMNS.map((column) => {
            const active = column.key === sortKey;
            const Arrow = descending ? ArrowDownIcon : ArrowUpIcon;
            return (
              <th
                key={column.key}
                scope="col"
                aria-sort={active ? (descending ? "descending" : "ascending") : undefined}
                className={cn("px-2 font-medium first:pl-3.5", column.className)}
              >
                <button
                  type="button"
                  onClick={() => onSortChange(column.key)}
                  className={cn(
                    "-mx-1 inline-flex h-6 max-w-full items-center gap-1 rounded-sm px-1 outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
                    active && "text-foreground",
                  )}
                >
                  <span className="truncate">{column.label}</span>
                  {active ? <Arrow aria-hidden="true" className="size-3 shrink-0" /> : null}
                </button>
              </th>
            );
          })}
          <th scope="col" className="w-9 pr-2 sm:w-10">
            <span className="sr-only">Actions</span>
          </th>
        </tr>
      </thead>
      <tbody ref={bodyRef} onKeyDown={onKeyDown}>
        {items.map((item, index) => {
          const series = item.seriesId ? seriesName(item.seriesId) : undefined;
          const overdue =
            item.targetAt !== null && !DONE_STATES.has(item.state) && isOverdue(item.targetAt, now);
          return (
            <tr
              key={item.id}
              data-item-id={item.id}
              onClick={(event) => onRowClick(event, item)}
              className={cn(
                "h-[38px] cursor-pointer border-divider border-t text-control transition-colors first:border-t-0",
                "hover:bg-secondary has-[a[data-row-link]:focus-visible]:bg-secondary",
                "has-[a[data-row-link]:focus-visible]:shadow-[inset_2px_0_0_var(--ring)]",
              )}
            >
              <td className="py-0 pr-2 pl-3.5">
                <div className="flex min-w-0 items-center gap-1.5">
                  <FormatIcon format={item.format} label />
                  <Link
                    to="/content/$itemId"
                    params={{ itemId: item.id }}
                    data-row-link=""
                    tabIndex={index === activeIndex ? 0 : -1}
                    onFocus={() => setActiveId(item.id)}
                    className="min-w-0 truncate text-body text-foreground outline-none"
                  >
                    {item.title}
                  </Link>
                  {item.lastError ? (
                    <span
                      title={item.lastError.message}
                      className="inline-flex shrink-0 text-status-red"
                    >
                      <TriangleAlertIcon aria-hidden="true" className="size-3.5" />
                      <span className="sr-only">Last step failed: {item.lastError.message}</span>
                    </span>
                  ) : null}
                </div>
              </td>
              <td className="hidden truncate px-2 text-text-2 md:table-cell">
                {series ?? <span className="text-text-4">—</span>}
              </td>
              <td className="px-2">
                <StatusPill kind="pipeline" status={item.state} />
              </td>
              <td className="hidden px-2 font-mono text-mono text-muted-foreground md:table-cell">
                v{item.versionNo}
              </td>
              <td
                className={cn(
                  "hidden px-2 tabular-nums sm:table-cell",
                  overdue ? "text-status-red" : "text-text-2",
                )}
              >
                {item.targetAt ? (
                  <time dateTime={item.targetAt} title={formatDateTime(item.targetAt)}>
                    {formatTargetDay(item.targetAt, now)}
                    {overdue ? <span className="sr-only"> (passed)</span> : null}
                  </time>
                ) : (
                  <span className="text-text-4">—</span>
                )}
              </td>
              <td className="hidden px-2 font-mono text-mono text-muted-foreground md:table-cell">
                {item.durationMs !== null ? formatDuration(item.durationMs) : "—"}
              </td>
              <td className="px-2">
                <RelativeTime
                  value={item.updatedAt}
                  className="font-mono text-[11px] text-muted-foreground"
                />
              </td>
              <td className="pr-2 text-right">{actions?.(item)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

const SKELETON_WIDTHS = ["58%", "42%", "66%", "36%", "50%", "46%"];

export function LibraryTableSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div aria-hidden="true">
      <div className="h-8 border-divider border-b" />
      {SKELETON_WIDTHS.slice(0, rows).map((width) => (
        <div
          key={width}
          className="flex h-[38px] items-center gap-3 border-divider border-t px-3.5 first:border-t-0"
        >
          <div className="flex-1">
            <Skeleton className="h-3" style={{ width }} />
          </div>
          <Skeleton className="hidden h-2.5 w-24 md:block" />
          <Skeleton className="h-[18px] w-16 rounded-full" />
          <Skeleton className="hidden h-2.5 w-12 sm:block" />
          <Skeleton className="h-2.5 w-8" />
        </div>
      ))}
    </div>
  );
}
