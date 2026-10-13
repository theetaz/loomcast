import type { ContentItemDetail, ItemAnalytics, PostAnalytics } from "@loomcast/contracts";
import { Skeleton } from "@loomcast/ui/components/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@loomcast/ui/components/tabs";
import { cn } from "@loomcast/ui/lib/cn";
import { useQuery } from "@tanstack/react-query";
import { ChartSplineIcon, ExternalLinkIcon, Rows3Icon } from "lucide-react";
import { type ReactNode, useState } from "react";
import { ErrorState } from "@/components/ErrorState";
import { RelativeTime } from "@/components/RelativeTime";
import { ChartMessage, ChartTable } from "./ChartFrame";
import {
  engagementRate,
  formatCount,
  formatMetric,
  formatMoment,
  formatRate,
  formatWatch,
  METRICS,
} from "./format";
import { PLATFORM_LABELS, platformColor } from "./platforms";
import { itemAnalyticsQueryOptions, useAnalyticsLive } from "./queries";
import { canSpark, Sparkline } from "./Sparkline";
import { openablePermalink } from "./TopPosts";
import "./viz.css";

/**
 * The item page's analytics: each live post's latest insights with a sparkline per metric, when
 * they were captured, and the link to the post. Renders nothing for an item that never went live.
 */
export default function ItemAnalyticsCard({ detail }: { detail: ContentItemDetail }) {
  useAnalyticsLive();
  const query = useQuery(itemAnalyticsQueryOptions(detail.item.id));
  if (query.isPending) return <ItemAnalyticsSkeleton />;
  if (query.isError) {
    return (
      <section aria-label="Performance" className="rounded-lg bg-card shadow-card">
        <ErrorState
          size="compact"
          title="Couldn't load the analytics"
          error={query.error}
          onRetry={() => void query.refetch()}
          retrying={query.isFetching}
        />
      </section>
    );
  }
  if (query.data.posts.length === 0) {
    if (detail.item.state !== "published") return null;
    return (
      <CardShell subtitle={null}>
        <ChartMessage
          className="mx-4 mb-4 min-h-[120px]"
          notice={{
            title: "No live posts to measure",
            description:
              "Insights come from posts published to a connected channel. Dry runs aren't measured.",
          }}
        />
      </CardShell>
    );
  }
  return <ItemAnalyticsView analytics={query.data} />;
}

function CardShell({
  subtitle,
  actions,
  children,
}: {
  subtitle: string | null;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      aria-labelledby="item-analytics-title"
      className="lc-viz rounded-lg bg-card shadow-card"
    >
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2 px-4 pt-3.5 pb-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h2 id="item-analytics-title" className="text-heading text-foreground">
            Performance
          </h2>
          {subtitle ? <p className="text-small text-muted-foreground">{subtitle}</p> : null}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

function ItemAnalyticsView({ analytics }: { analytics: ItemAnalytics }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [view, setView] = useState<"chart" | "table">("chart");
  const selected =
    analytics.posts.find((entry) => entry.post.postId === selectedId) ?? analytics.posts[0];
  if (!selected) return null;
  const { totals } = analytics;
  const count = analytics.posts.length;
  const subtitle =
    count === 1
      ? `1 live post`
      : `${count} live posts · ${formatCount(totals.views)} views · ${formatRate(totals.engagementRate)} engagement · ${formatWatch(totals.avgWatchMs)} average watch`;

  return (
    <Tabs
      value={view}
      onValueChange={(value) => setView(value as "chart" | "table")}
      className="gap-0"
    >
      <CardShell
        subtitle={subtitle}
        actions={
          <TabsList aria-label="Show performance as">
            <TabsTrigger value="chart" className="flex-none">
              <ChartSplineIcon aria-hidden="true" />
              Chart
            </TabsTrigger>
            <TabsTrigger value="table" className="flex-none">
              <Rows3Icon aria-hidden="true" />
              Table
            </TabsTrigger>
          </TabsList>
        }
      >
        {count > 1 ? (
          <fieldset className="flex flex-wrap gap-1.5 px-4 pb-3">
            <legend className="sr-only">Post</legend>
            {analytics.posts.map(({ post }) => {
              const on = post.postId === selected.post.postId;
              return (
                <button
                  key={post.postId}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setSelectedId(post.postId)}
                  className={cn(
                    "pressable inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-small outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    on
                      ? "bg-accent-soft text-foreground shadow-[0_0_0_1px_var(--ring)]"
                      : "bg-secondary text-text-2 shadow-[0_0_0_1px_var(--border)] hover:text-foreground",
                  )}
                >
                  <span
                    aria-hidden="true"
                    className="size-2 rounded-full"
                    style={{ background: platformColor(post.platform) }}
                  />
                  {PLATFORM_LABELS[post.platform]}
                  <span className="text-muted-foreground tabular-nums">
                    {formatCount(post.metrics?.views ?? null)}
                  </span>
                </button>
              );
            })}
          </fieldset>
        ) : null}
        <PostStatus entry={selected} />
        <TabsContent value="chart" tabIndex={-1} className="px-4 pt-3 pb-4">
          <MetricTiles entry={selected} />
        </TabsContent>
        <TabsContent value="table" tabIndex={-1} className="pt-1 pb-1">
          <CapturesTable entry={selected} />
        </TabsContent>
      </CardShell>
    </Tabs>
  );
}

function PostStatus({ entry }: { entry: PostAnalytics }) {
  const { post, nextCaptureAt } = entry;
  const latest = entry.history.at(-1);
  const permalink = openablePermalink(post.permalink);
  const platform = PLATFORM_LABELS[post.platform];
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-divider border-t px-4 pt-3 text-small text-muted-foreground">
      <span>Live since {formatMoment(post.publishedAt)}</span>
      {latest ? (
        <span>
          Captured <RelativeTime value={latest.capturedAt} format="relative" />
        </span>
      ) : null}
      {nextCaptureAt ? (
        <span>
          Next capture <RelativeTime value={nextCaptureAt} format="relative" />
        </span>
      ) : (
        <span>Final capture</span>
      )}
      {permalink ? (
        <a
          href={permalink}
          target="_blank"
          rel="noopener noreferrer"
          className="ml-auto inline-flex items-center gap-1 rounded-sm text-text-2 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          Open on {platform}
          <ExternalLinkIcon aria-hidden="true" className="size-3.5" />
        </a>
      ) : null}
    </div>
  );
}

function MetricTiles({ entry }: { entry: PostAnalytics }) {
  const { history, post } = entry;
  const latest = history.at(-1);
  if (!latest) {
    return (
      <ChartMessage
        className="min-h-[120px]"
        notice={{
          title: "Not enough data yet",
          description: entry.nextCaptureAt
            ? `The first insights arrive ${formatMoment(entry.nextCaptureAt)}.`
            : "Insights arrive about an hour after the post goes live.",
        }}
      />
    );
  }
  const color = platformColor(post.platform);
  const rate = engagementRate(latest);
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
      {METRICS.map(({ key, label }) => {
        const value = latest[key];
        return (
          <div key={key} className="flex min-w-0 flex-col gap-0.5">
            <dt className="truncate text-small text-muted-foreground">{label}</dt>
            <dd className="text-[17px] leading-6 font-semibold text-foreground">
              {value === null ? (
                <span className="text-control font-normal text-muted-foreground">Not reported</span>
              ) : (
                formatMetric(key, value)
              )}
            </dd>
            <dd>
              {value !== null && canSpark(history, key) ? (
                <Sparkline history={history} metric={key} label={label} color={color} />
              ) : value !== null ? (
                <span className="flex h-8 items-center text-small text-muted-foreground">
                  Not enough data yet
                </span>
              ) : (
                <span className="block h-8" />
              )}
            </dd>
          </div>
        );
      })}
      <div className="flex min-w-0 flex-col gap-0.5">
        <dt className="truncate text-small text-muted-foreground">Engagement rate</dt>
        <dd className="text-[17px] leading-6 font-semibold text-foreground">{formatRate(rate)}</dd>
        <dd className="flex h-8 items-center text-small text-muted-foreground">Per view</dd>
      </div>
    </dl>
  );
}

/** The card's table twin: every capture of the selected post, newest first. */
function CapturesTable({ entry }: { entry: PostAnalytics }) {
  if (entry.history.length === 0) {
    return (
      <p className="px-4 pt-2 pb-4 text-small text-muted-foreground">
        No captures yet. Insights arrive about an hour after the post goes live.
      </p>
    );
  }
  return (
    <ChartTable
      caption={`${PLATFORM_LABELS[entry.post.platform]} insights captures`}
      columns={[
        { id: "captured", label: "Captured" },
        ...METRICS.map(({ key, label }) => ({ id: key, label, numeric: true })),
      ]}
      rows={[...entry.history].reverse().map((capture) => ({
        id: capture.capturedAt,
        cells: [
          formatMoment(capture.capturedAt),
          ...METRICS.map(({ key }) => {
            const value = capture[key];
            return value === null ? "Not reported" : formatMetric(key, value, true);
          }),
        ],
      }))}
    />
  );
}

function ItemAnalyticsSkeleton() {
  return (
    <div aria-hidden="true" className="flex flex-col gap-3 rounded-lg bg-card p-4 shadow-card">
      <Skeleton className="h-4 w-28" />
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {[0, 1, 2, 3].map((index) => (
          <div key={index} className="flex flex-col gap-1.5">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-5 w-12" />
            <Skeleton className="h-6 w-full" />
          </div>
        ))}
      </div>
    </div>
  );
}
