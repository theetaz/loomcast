import type { ContentItem, Format, Series, Workspace } from "@loomcast/contracts";
import { Button } from "@loomcast/ui/components/button";
import { Skeleton } from "@loomcast/ui/components/skeleton";
import { cn } from "@loomcast/ui/lib/cn";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ListVideoIcon, PlusIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { cadenceSummary, formatSlot, upcomingSlots } from "@/features/formats/cadence";
import { formatsListQueryOptions } from "@/features/formats/queries";
import { formatTargetDay } from "@/features/library/format";
import { contentListQueryOptions, seriesListQueryOptions } from "@/features/library/queries";
import { useContentLive } from "@/features/library/use-content-live";
import { formatDateTime } from "@/lib/format";
import { useNow } from "@/lib/use-now";
import { NewSeriesDialog } from "./NewSeriesDialog";
import { upcomingBySeries, upcomingFilter } from "./queries";
import { SeriesStatusBadge } from "./SeriesStatusBadge";

const STATUS_ORDER = { active: 0, paused: 1, archived: 2 } as const;

/** Active series first, then paused, then archived; by name within each. */
export function sortSeries(series: readonly Series[]): Series[] {
  return [...series].sort(
    (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.name.localeCompare(b.name),
  );
}

/**
 * The workspace's Series tab: each series with its format, status, cadence and the videos coming
 * up. Archived series are folded away until asked for.
 */
export function SeriesList({
  workspace,
  workspaceParam,
}: {
  workspace: Workspace;
  workspaceParam: string;
}) {
  useContentLive();
  const now = useNow();
  const series = useQuery(seriesListQueryOptions(workspace.id));
  const formats = useQuery(formatsListQueryOptions(workspace.id));
  const upcoming = useInfiniteQuery(contentListQueryOptions(upcomingFilter(workspace.id)));
  const [showArchived, setShowArchived] = useState(false);

  const formatById = useMemo(
    () => new Map((formats.data?.items ?? []).map((format) => [format.id, format])),
    [formats.data],
  );
  const itemsBySeries = useMemo(
    () => upcomingBySeries(upcoming.data?.pages.flatMap((page) => page.items) ?? []),
    [upcoming.data],
  );
  const all = sortSeries(series.data?.items ?? []);
  const archivedCount = all.filter((entry) => entry.status === "archived").length;
  const shown = showArchived ? all : all.filter((entry) => entry.status !== "archived");
  const canCreate = workspace.status === "active";

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h1 className="text-title">Series</h1>
          <p className="text-control text-muted-foreground">
            Videos that share a format and a publishing cadence.
          </p>
        </div>
        {canCreate ? (
          <NewSeriesDialog workspaceId={workspace.id} workspaceParam={workspaceParam}>
            <Button className="self-start sm:self-auto">
              <PlusIcon aria-hidden="true" />
              New series
            </Button>
          </NewSeriesDialog>
        ) : null}
      </div>

      <section aria-label="Series" className="overflow-hidden rounded-lg bg-card shadow-card">
        {series.isPending ? (
          <SeriesTableSkeleton />
        ) : series.isError ? (
          <ErrorState
            size="compact"
            title="Couldn't load the series"
            error={series.error}
            onRetry={() => void series.refetch()}
            retrying={series.isFetching}
          />
        ) : all.length === 0 ? (
          <EmptyState
            size="compact"
            icon={ListVideoIcon}
            title="No series yet"
            description="A series sets the tone, length, look and cadence its videos share. Create one to plan videos on a schedule."
            action={
              canCreate ? (
                <NewSeriesDialog workspaceId={workspace.id} workspaceParam={workspaceParam}>
                  <Button variant="outline">
                    <PlusIcon aria-hidden="true" />
                    New series
                  </Button>
                </NewSeriesDialog>
              ) : undefined
            }
          />
        ) : (
          <>
            <table className="w-full table-fixed border-collapse text-left">
              <caption className="sr-only">Series of {workspace.name}</caption>
              <thead>
                <tr className="h-8 border-divider border-b text-small text-muted-foreground">
                  <th scope="col" className="px-2 pl-3.5 font-medium">
                    Name
                  </th>
                  <th scope="col" className="hidden w-[150px] px-2 font-medium lg:table-cell">
                    Format
                  </th>
                  <th scope="col" className="w-[88px] px-2 font-medium">
                    Status
                  </th>
                  <th scope="col" className="hidden w-[30%] px-2 font-medium md:table-cell">
                    Cadence
                  </th>
                  <th scope="col" className="hidden w-[30%] px-2 pr-3.5 font-medium sm:table-cell">
                    Upcoming
                  </th>
                </tr>
              </thead>
              <tbody>
                {shown.map((entry) => (
                  <SeriesRow
                    key={entry.id}
                    series={entry}
                    format={formatById.get(entry.formatId)}
                    formatsLoading={formats.isPending}
                    items={itemsBySeries.get(entry.id) ?? []}
                    itemsLoading={upcoming.isPending}
                    workspaceParam={workspaceParam}
                    now={now}
                  />
                ))}
              </tbody>
            </table>
            {archivedCount > 0 ? (
              <div className="flex h-10 items-center border-divider border-t px-3.5">
                <Button
                  variant="ghost"
                  size="sm"
                  aria-pressed={showArchived}
                  onClick={() => setShowArchived((value) => !value)}
                >
                  {showArchived ? "Hide archived" : `Show archived (${archivedCount})`}
                </Button>
              </div>
            ) : null}
          </>
        )}
      </section>
    </div>
  );
}

function SeriesRow({
  series,
  format,
  formatsLoading,
  items,
  itemsLoading,
  workspaceParam,
  now,
}: {
  series: Series;
  format: Format | undefined;
  formatsLoading: boolean;
  items: ContentItem[];
  itemsLoading: boolean;
  workspaceParam: string;
  now: number;
}) {
  const cadence = format?.currentVersion.rules.cadence;
  const nextSlot =
    cadence && series.status === "active" ? upcomingSlots(cadence, 1, now)[0] : undefined;
  const next = items[0];
  return (
    <tr
      className={cn(
        "h-[52px] border-divider border-t align-middle text-control first:border-t-0",
        series.status === "archived" && "text-muted-foreground",
      )}
    >
      <td className="py-1.5 pr-2 pl-3.5">
        <Link
          to="/w/$workspace/series/$seriesId"
          params={{ workspace: workspaceParam, seriesId: series.id }}
          className="block min-w-0 truncate rounded-sm font-medium text-body text-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
        >
          {series.name}
        </Link>
        {/* Narrow screens hide the cadence column, wider ones the format column. */}
        <span className="block truncate text-small text-muted-foreground md:hidden">
          {cadence ? cadenceSummary(cadence) : series.slug}
        </span>
        <span className="hidden truncate text-small text-muted-foreground md:block lg:hidden">
          {format?.name ?? series.slug}
        </span>
      </td>
      <td className="hidden truncate px-2 text-text-2 lg:table-cell">
        {format ? format.name : formatsLoading ? <Skeleton className="h-2.5 w-20" /> : "—"}
      </td>
      <td className="px-2">
        <SeriesStatusBadge status={series.status} />
      </td>
      <td className="hidden px-2 md:table-cell">
        {cadence ? (
          <div className="flex min-w-0 flex-col">
            <span className="truncate text-text-2" title={cadenceSummary(cadence)}>
              {cadenceSummary(cadence)}
            </span>
            <span className="truncate font-mono text-[11px] text-muted-foreground">
              {series.status !== "active"
                ? "No slots while not active"
                : nextSlot
                  ? `Next slot ${formatSlot(nextSlot, cadence.tz)}`
                  : "No upcoming slots"}
            </span>
          </div>
        ) : formatsLoading ? (
          <Skeleton className="h-2.5 w-32" />
        ) : (
          <span className="text-text-4">—</span>
        )}
      </td>
      <td className="hidden px-2 pr-3.5 sm:table-cell">
        {itemsLoading ? (
          <Skeleton className="h-2.5 w-28" />
        ) : next ? (
          <div className="flex min-w-0 flex-col">
            <Link
              to="/w/$workspace/content/$itemId"
              params={{ workspace: workspaceParam, itemId: next.id }}
              className="truncate rounded-sm text-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
            >
              {next.title}
            </Link>
            <span className="truncate text-small text-muted-foreground">
              {next.targetAt ? (
                <time dateTime={next.targetAt} title={formatDateTime(next.targetAt)}>
                  {formatTargetDay(next.targetAt, now)}
                </time>
              ) : (
                "No date"
              )}
              {items.length > 1 ? ` · ${items.length - 1} more` : ""}
            </span>
          </div>
        ) : (
          <span className="text-text-4">Nothing planned</span>
        )}
      </td>
    </tr>
  );
}

function SeriesTableSkeleton() {
  return (
    <div aria-hidden="true">
      <div className="h-8 border-divider border-b" />
      {["46%", "38%", "52%"].map((width) => (
        <div
          key={width}
          className="flex h-[52px] items-center gap-3 border-divider border-t px-3.5 first:border-t-0"
        >
          <div className="flex-1">
            <Skeleton className="h-3" style={{ width }} />
          </div>
          <Skeleton className="h-[18px] w-14 rounded-full" />
          <Skeleton className="hidden h-2.5 w-40 md:block" />
          <Skeleton className="hidden h-2.5 w-32 sm:block" />
        </div>
      ))}
    </div>
  );
}
