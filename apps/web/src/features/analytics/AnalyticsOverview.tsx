import type { AnalyticsOverview as Overview } from "@loomcast/contracts";
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
import { ChartColumnBigIcon } from "lucide-react";
import { useMemo } from "react";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { projectsQueryOptions } from "@/features/projects/queries";
import { ChartFrame, type ChartNotice, Legend } from "./ChartFrame";
import { formatCount, formatFullCount, formatRate, plural } from "./format";
import { type Kpi, KpiTiles, KpiTilesSkeleton } from "./KpiTiles";
import { PLATFORM_LABELS, platformColor } from "./platforms";
import { overviewQueryOptions, useAnalyticsLive } from "./queries";
import { OVERVIEW_RANGES, type OverviewRange, overviewRange } from "./range";
import { type ViewsTrend, viewsTrend } from "./scales";
import { TopPostsTable } from "./TopPosts";
import { ViewsTrendChart, ViewsTrendTable } from "./ViewsTrendChart";
import "./viz.css";

const ALL_PROJECTS = "all";

/** The overview's four headline figures. */
export function overviewKpis(overview: Overview): Kpi[] {
  const { totals } = overview;
  const waiting = totals.posts - totals.measuredPosts;
  return [
    {
      id: "posts",
      label: "Posts published",
      value: formatFullCount(totals.posts),
      detail: waiting > 0 ? `${formatFullCount(waiting)} waiting for insights` : "All measured",
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
      detail:
        totals.medianViews === null
          ? "Not enough data yet"
          : `Across ${plural(totals.measuredPosts, "measured post")}`,
    },
    {
      id: "engagement",
      label: "Engagement rate",
      value: formatRate(totals.engagementRate),
      detail: totals.engagementRate === null ? "Not enough data yet" : "Interactions per view",
    },
  ];
}

/** Why the trend can't be drawn yet, or null when it can. */
export function trendNotice(overview: Overview, trend: ViewsTrend): ChartNotice | null {
  if (overview.totals.measuredPosts === 0) {
    return {
      title: "Not enough data yet",
      description:
        "Insights arrive about an hour after a post goes live, then again over its first month.",
    };
  }
  if (trend.activeBuckets < 2) {
    return {
      title: "Not enough data yet",
      description: `The trend needs posts on at least two ${trend.granularity}s in this range.`,
    };
  }
  return null;
}

export interface AnalyticsOverviewProps {
  range: OverviewRange;
  projectId: string | null;
  onRangeChange: (range: OverviewRange) => void;
  onProjectChange: (projectId: string | null) => void;
}

/**
 * Posts that went live in a range: headline figures, views over time per platform, the top
 * posts. Filters sit in one row above everything they scope.
 */
export function AnalyticsOverview({
  range,
  projectId,
  onRangeChange,
  onProjectChange,
}: AnalyticsOverviewProps) {
  useAnalyticsLive();
  const bounds = overviewRange(range);
  const query = useQuery(overviewQueryOptions({ ...bounds, ...(projectId ? { projectId } : {}) }));
  const projects = useQuery(projectsQueryOptions());
  const overview = query.data;
  const trend = useMemo(() => (overview ? viewsTrend(overview) : null), [overview]);
  const busy = query.isPlaceholderData;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={range} onValueChange={(value) => onRangeChange(value as OverviewRange)}>
          <SelectTrigger aria-label="Range" className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(OVERVIEW_RANGES) as OverviewRange[]).map((key) => (
              <SelectItem key={key} value={key}>
                {OVERVIEW_RANGES[key].label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={projectId ?? ALL_PROJECTS}
          onValueChange={(value) => onProjectChange(value === ALL_PROJECTS ? null : value)}
        >
          <SelectTrigger aria-label="Project" className="w-56 max-w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_PROJECTS}>All projects</SelectItem>
            {(projects.data ?? []).map((project) => (
              <SelectItem key={project.id} value={project.id}>
                {project.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="ml-auto hidden text-small text-muted-foreground sm:block">
          Live posts only. Dry runs aren't measured.
        </p>
      </div>

      {query.isPending ? (
        <OverviewSkeleton />
      ) : query.isError || !overview || !trend ? (
        <section className="rounded-lg bg-card shadow-card">
          <ErrorState
            title="Couldn't load the analytics"
            error={query.error}
            onRetry={() => void query.refetch()}
            retrying={query.isFetching}
          />
        </section>
      ) : overview.totals.posts === 0 ? (
        <section aria-label="Analytics" className="rounded-lg bg-card shadow-card">
          <EmptyState
            icon={ChartColumnBigIcon}
            title="Nothing went live in this range"
            description="Analytics follow posts once they are published to a connected channel."
            action={
              range !== "12m" ? (
                <Button variant="outline" onClick={() => onRangeChange("12m")}>
                  Show the last 12 months
                </Button>
              ) : (
                <Button asChild variant="outline">
                  <Link to="/library">Open the library</Link>
                </Button>
              )
            }
          />
        </section>
      ) : (
        <>
          <KpiTiles items={overviewKpis(overview)} busy={busy} />
          <ChartFrame
            title="Views over time"
            description={`Running total of views per platform, by the ${trend.granularity} each post went live.`}
            busy={busy}
            notice={trendNotice(overview, trend)}
            legend={
              <Legend
                entries={overview.platforms.map(({ platform, totals }) => ({
                  id: platform,
                  label: PLATFORM_LABELS[platform],
                  color: platformColor(platform),
                  detail: formatCount(totals.views),
                }))}
              />
            }
            chart={<ViewsTrendChart trend={trend} title="Views over time" />}
            table={<ViewsTrendTable trend={trend} caption="Views over time, per platform" />}
          />
          <section
            aria-labelledby="top-posts-title"
            aria-busy={busy || undefined}
            className="lc-viz rounded-lg bg-card shadow-card"
          >
            <div className="flex items-baseline gap-2 px-4 pt-3.5 pb-2">
              <h2 id="top-posts-title" className="text-heading text-foreground">
                Top posts
              </h2>
              <p className="text-small text-muted-foreground">By views, latest capture</p>
            </div>
            <TopPostsTable posts={overview.topPosts} />
          </section>
        </>
      )}
    </div>
  );
}

function OverviewSkeleton() {
  return (
    <div aria-busy="true" className="flex flex-col gap-5">
      <span className="sr-only">Loading the analytics</span>
      <KpiTilesSkeleton />
      <div className="flex flex-col gap-3 rounded-lg bg-card p-4 shadow-card">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-[220px] w-full" />
      </div>
    </div>
  );
}
