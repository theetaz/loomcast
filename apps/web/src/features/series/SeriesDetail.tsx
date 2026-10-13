import type { ContentItem, Project, Series } from "@loomcast/contracts";
import { Button } from "@loomcast/ui/components/button";
import { StatusPill } from "@loomcast/ui/components/StatusPill";
import { Skeleton } from "@loomcast/ui/components/skeleton";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArchiveIcon, FilmIcon, ListVideoIcon, PauseIcon, PlusIcon } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { RelativeTime } from "@/components/RelativeTime";
import { formatQueryOptions } from "@/features/formats/queries";
import { formatTargetDay } from "@/features/library/format";
import { NewIdeaDialog } from "@/features/library/NewIdeaDialog";
import { contentListQueryOptions } from "@/features/library/queries";
import { useContentLive } from "@/features/library/use-content-live";
import { isApiError } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { useNow } from "@/lib/use-now";
import { useTitle } from "@/lib/use-title";
import { seriesCards } from "./cards/registry";
import { compareUpcoming, seriesQueryOptions, upcomingFilter } from "./queries";
import { SeriesActions } from "./SeriesActions";
import { SeriesStatusBadge } from "./SeriesStatusBadge";

/** A series: its status and actions, the videos coming up and the cards beside them. */
export function SeriesDetail({
  project,
  projectParam,
  seriesId,
}: {
  project: Project;
  projectParam: string;
  seriesId: string;
}) {
  const query = useQuery(seriesQueryOptions(seriesId));
  useTitle(query.data ? `${query.data.name} · ${project.name}` : `Series · ${project.name}`);

  if (query.isPending) {
    return (
      <div aria-hidden="true" className="flex flex-col gap-4">
        <Skeleton className="h-6 w-64 max-w-full" />
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
          <Skeleton className="h-64 rounded-lg" />
          <Skeleton className="h-48 rounded-lg" />
        </div>
      </div>
    );
  }
  if (query.isError || query.data.projectId !== project.id) {
    return isApiError(query.error, 404) || query.data ? (
      <EmptyState
        icon={ListVideoIcon}
        title="Series not found"
        description="It may belong to another project, or the link points somewhere else."
        action={
          <Button asChild variant="outline">
            <Link to="/projects/$projectId/series" params={{ projectId: projectParam }}>
              All series
            </Link>
          </Button>
        }
      />
    ) : (
      <ErrorState
        title="Couldn't load this series"
        error={query.error}
        onRetry={() => void query.refetch()}
        retrying={query.isFetching}
      />
    );
  }
  return <SeriesBody series={query.data} project={project} projectParam={projectParam} />;
}

function SeriesBody({
  series,
  project,
  projectParam,
}: {
  series: Series;
  project: Project;
  projectParam: string;
}) {
  useContentLive();
  const format = useQuery(formatQueryOptions(series.formatId));
  const writable = project.status === "active";
  const canPlan = writable && series.status !== "archived";

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h2 className="text-title min-w-0 break-words">{series.name}</h2>
            <SeriesStatusBadge status={series.status} />
          </div>
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-small text-muted-foreground">
            <code className="max-w-full truncate font-mono text-mono">{series.slug}</code>
            <span aria-hidden="true">·</span>
            <span>
              Updated <RelativeTime value={series.updatedAt} format="relative" />
            </span>
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {canPlan ? (
            <NewIdeaDialog projectId={project.id} defaultSeriesId={series.id}>
              <Button>
                <PlusIcon aria-hidden="true" />
                New idea
              </Button>
            </NewIdeaDialog>
          ) : null}
          {writable ? <SeriesActions series={series} /> : null}
        </div>
      </header>

      {series.status !== "active" ? (
        <div
          role="status"
          className="flex items-start gap-2.5 rounded-lg bg-card px-3.5 py-2.5 text-control text-text-2 shadow-card"
        >
          {series.status === "paused" ? (
            <PauseIcon aria-hidden="true" className="mt-px size-4 shrink-0 text-status-amber" />
          ) : (
            <ArchiveIcon
              aria-hidden="true"
              className="mt-px size-4 shrink-0 text-muted-foreground"
            />
          )}
          <p>
            {series.status === "paused"
              ? "Paused. No videos are planned for its slots until you resume it; videos already in production carry on."
              : "Archived. The series plans nothing new; its videos stay in the library."}
          </p>
        </div>
      ) : null}

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <UpcomingVideos series={series} project={project} projectParam={projectParam} />
        <div className="flex min-w-0 flex-col gap-4">
          {seriesCards.map(({ id, Card }) => (
            <Card
              key={id}
              series={series}
              project={project}
              format={format.data}
              projectParam={projectParam}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function UpcomingVideos({
  series,
  project,
  projectParam,
}: {
  series: Series;
  project: Project;
  projectParam: string;
}) {
  const now = useNow();
  const query = useInfiniteQuery(contentListQueryOptions(upcomingFilter(project.id, series.id)));
  const items: ContentItem[] = (query.data?.pages.flatMap((page) => page.items) ?? [])
    .filter((item) => item.seriesId === series.id)
    .sort(compareUpcoming);

  return (
    <section
      aria-labelledby="series-upcoming"
      className="overflow-hidden rounded-lg bg-card shadow-card"
    >
      <div className="flex h-11 items-center gap-2 border-divider border-b px-3.5">
        <h3 id="series-upcoming" className="font-semibold text-[13px]">
          Upcoming videos
        </h3>
        {query.data ? (
          <span className="text-small text-muted-foreground tabular-nums">{items.length}</span>
        ) : null}
        <Button asChild variant="ghost" size="sm" className="ml-auto">
          <Link
            to="/projects/$projectId/content"
            params={{ projectId: projectParam }}
            search={{ series: series.id }}
          >
            Open in content
          </Link>
        </Button>
      </div>
      {query.isPending ? (
        <div aria-hidden="true" className="flex flex-col">
          {["52%", "40%", "61%"].map((width) => (
            <div
              key={width}
              className="flex h-10 items-center gap-3 border-divider border-t px-3.5 first:border-t-0"
            >
              <Skeleton className="h-3" style={{ width }} />
              <Skeleton className="ml-auto h-[18px] w-16 rounded-full" />
            </div>
          ))}
        </div>
      ) : query.isError ? (
        <ErrorState
          size="compact"
          title="Couldn't load the videos"
          error={query.error}
          onRetry={() => void query.refetch()}
          retrying={query.isFetching}
        />
      ) : items.length === 0 ? (
        <EmptyState
          size="compact"
          icon={FilmIcon}
          title="Nothing coming up"
          description={
            series.status === "active"
              ? "Videos appear here as ideas are added or planned for the cadence's slots."
              : "Nothing is in production for this series."
          }
        />
      ) : (
        <ul>
          {items.map((item) => (
            <li
              key={item.id}
              className="flex h-10 items-center gap-3 border-divider border-t px-3.5 text-control first:border-t-0 hover:bg-secondary"
            >
              <Link
                to="/content/$itemId"
                params={{ itemId: item.id }}
                className="min-w-0 flex-1 truncate rounded-sm text-body text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {item.title}
              </Link>
              <StatusPill kind="pipeline" status={item.state} />
              <span className="hidden w-16 shrink-0 text-right tabular-nums text-text-2 sm:block">
                {item.targetAt ? (
                  <time dateTime={item.targetAt} title={formatDateTime(item.targetAt)}>
                    {formatTargetDay(item.targetAt, now)}
                  </time>
                ) : (
                  <span className="text-text-4">—</span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
