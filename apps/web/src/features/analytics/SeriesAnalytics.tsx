import type { SeriesAnalytics as SeriesData } from "@loomcast/contracts";
import { Button } from "@loomcast/ui/components/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@loomcast/ui/components/select";
import { Skeleton } from "@loomcast/ui/components/skeleton";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChartColumnBigIcon, FileQuestionIcon } from "lucide-react";
import { useMemo } from "react";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { Page, PageHeader } from "@/components/PageHeader";
import { seriesQueryOptions } from "@/features/series/queries";
import { useCurrentWorkspace } from "@/features/workspace/current";
import { isApiError } from "@/lib/api";
import { useTitle } from "@/lib/use-title";
import { ChartFrame, type ChartNotice, Legend } from "./ChartFrame";
import { formatCount, formatFullCount, formatWatch, plural } from "./format";
import { type Kpi, KpiTiles, KpiTilesSkeleton } from "./KpiTiles";
import { PostBarsChart, PostBarsTable } from "./PostBarsChart";
import { orderPlatforms, PLATFORM_LABELS, platformColor } from "./platforms";
import { seriesAnalyticsQueryOptions, useAnalyticsLive } from "./queries";
import { SERIES_RANGES, type SeriesRange, seriesRange } from "./range";
import { postsByDate } from "./scales";
import "./viz.css";

export function seriesKpis(data: SeriesData): Kpi[] {
  const { totals } = data;
  return [
    {
      id: "posts",
      label: "Posts published",
      value: formatFullCount(totals.posts),
      detail: `${formatFullCount(totals.measuredPosts)} measured`,
    },
    {
      id: "views",
      label: "Total views",
      value: totals.measuredPosts > 0 ? formatCount(totals.views) : "—",
      detail:
        totals.measuredPosts > 0 ? `${formatFullCount(totals.views)} views` : "Not enough data yet",
    },
    {
      id: "median",
      label: "Median views per post",
      value: formatCount(totals.medianViews),
      detail: totals.medianViews === null ? "Not enough data yet" : "Latest capture of each post",
    },
    {
      id: "watch",
      label: "Average watch time",
      value: formatWatch(totals.avgWatchMs),
      detail:
        totals.avgWatchMs === null ? "No platform reported it yet" : "Per view, weighted by views",
    },
  ];
}

/** Bars need two measured posts; a single bar is a number, and the tiles already show it. */
export function barsNotice(data: SeriesData, measure: "views" | "avgWatchMs"): ChartNotice | null {
  const measured = data.posts.filter((post) => (post.metrics?.[measure] ?? null) !== null).length;
  if (measured >= 2) return null;
  if (measure === "avgWatchMs" && data.totals.measuredPosts >= 2) {
    return {
      title: "Not enough data yet",
      description: "Watch time comes from Facebook and Instagram; Threads doesn't report it.",
    };
  }
  return {
    title: "Not enough data yet",
    description: "The chart needs insights from at least two posts.",
  };
}

/**
 * One series: headline figures, views per post by publish date and average watch time per post,
 * as two aligned charts on their own axes.
 */
export function SeriesAnalyticsPage({
  seriesId,
  range,
  onRangeChange,
}: {
  seriesId: string;
  range: SeriesRange;
  onRangeChange: (range: SeriesRange) => void;
}) {
  useAnalyticsLive();
  const workspace = useCurrentWorkspace();
  const series = useQuery(seriesQueryOptions(seriesId));
  const query = useQuery(seriesAnalyticsQueryOptions(seriesId, seriesRange(range)));
  useTitle(series.data ? `${series.data.name} analytics` : "Series analytics");
  const posts = useMemo(() => postsByDate(query.data?.posts ?? []), [query.data]);
  const busy = query.isPlaceholderData;

  // A series of another workspace is not found here, like any other id.
  if (
    (series.isError && isApiError(series.error, 404)) ||
    (series.data && series.data.workspaceId !== workspace.id)
  ) {
    return (
      <Page className="flex-1 justify-center">
        <EmptyState
          icon={FileQuestionIcon}
          title="Series not found"
          description="It may have been removed, or the link points somewhere else."
          action={
            <Button asChild variant="outline">
              <Link to="/w/$workspace/analytics" params={{ workspace: workspace.slug }}>
                Open the analytics
              </Link>
            </Button>
          }
        />
      </Page>
    );
  }

  const data = query.data;
  // The bars carry the platform's colour, so the legend names the platforms that have bars.
  const legendFor = (measure: "views" | "avgWatchMs") => {
    const platforms = orderPlatforms(
      posts
        .filter((post) => (post.metrics?.[measure] ?? null) !== null)
        .map((post) => post.platform),
    );
    return platforms.length > 0 ? (
      <Legend
        mark="square"
        entries={platforms.map((platform) => ({
          id: platform,
          label: PLATFORM_LABELS[platform],
          color: platformColor(platform),
        }))}
      />
    ) : undefined;
  };

  return (
    <Page className="max-w-[1240px]">
      <PageHeader
        title={
          series.data ? (
            series.data.name
          ) : (
            <Skeleton
              aria-label="Loading the series"
              className="inline-block h-5 w-48 align-middle"
            />
          )
        }
        description="Views and watch time of every post in the series"
        actions={
          series.data ? (
            <Button asChild variant="outline">
              <Link
                to="/w/$workspace/series/$seriesId"
                params={{ workspace: workspace.slug, seriesId: series.data.id }}
              >
                Open the series
              </Link>
            </Button>
          ) : null
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <Select value={range} onValueChange={(value) => onRangeChange(value as SeriesRange)}>
          <SelectTrigger aria-label="Range" className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(SERIES_RANGES) as SeriesRange[]).map((key) => (
              <SelectItem key={key} value={key}>
                {SERIES_RANGES[key].label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {data ? (
          <p className="text-control text-muted-foreground" aria-live="polite">
            {plural(data.totals.posts, "post")}
          </p>
        ) : null}
      </div>

      {query.isPending ? (
        <div aria-busy="true" className="flex flex-col gap-5">
          <span className="sr-only">Loading the analytics</span>
          <KpiTilesSkeleton />
          <Skeleton className="h-[280px] w-full rounded-lg" />
        </div>
      ) : query.isError || !data ? (
        <section className="rounded-lg bg-card shadow-card">
          <ErrorState
            title="Couldn't load the series analytics"
            error={query.error}
            onRetry={() => void query.refetch()}
            retrying={query.isFetching}
          />
        </section>
      ) : data.totals.posts === 0 ? (
        <section aria-label="Analytics" className="rounded-lg bg-card shadow-card">
          <EmptyState
            icon={ChartColumnBigIcon}
            title={
              range === "all"
                ? "Nothing from this series went live yet"
                : "Nothing went live in this range"
            }
            description="Posts appear here once they are published to a connected channel."
            action={
              range !== "all" ? (
                <Button variant="outline" onClick={() => onRangeChange("all")}>
                  Show all time
                </Button>
              ) : undefined
            }
          />
        </section>
      ) : (
        <>
          <KpiTiles items={seriesKpis(data)} busy={busy} />
          <ChartFrame
            kind="bars"
            title="Views per post"
            description="Latest views of each post, by publish date."
            busy={busy}
            notice={barsNotice(data, "views")}
            legend={legendFor("views")}
            chart={<PostBarsChart posts={posts} measure="views" title="Views per post" />}
            table={<PostBarsTable posts={posts} measure="views" caption="Views per post" />}
          />
          <ChartFrame
            kind="bars"
            title="Average watch time per post"
            description="How long a view lasts on average, where the platform reports it."
            busy={busy}
            notice={barsNotice(data, "avgWatchMs")}
            legend={legendFor("avgWatchMs")}
            chart={
              <PostBarsChart
                posts={posts}
                measure="avgWatchMs"
                title="Average watch time per post"
              />
            }
            table={
              <PostBarsTable
                posts={posts}
                measure="avgWatchMs"
                caption="Average watch time per post"
              />
            }
          />
        </>
      )}
    </Page>
  );
}
