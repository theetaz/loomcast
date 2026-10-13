import type { PostPerformance } from "@loomcast/contracts";
import { ChartTable, ChartTooltip } from "./ChartFrame";
import { ChartPoints } from "./ChartPoints";
import { formatCount, formatDay, formatWatch } from "./format";
import { PLATFORM_LABELS, platformColor } from "./platforms";
import { barLayout, barPath, tickIndices, valueScale } from "./scales";
import { type PostMeasure, postMeasure, postTooltip, tooltipText } from "./tooltips";
import { useChartPoints, useChartWidth } from "./use-chart";

const PLOT_HEIGHT = 200;
const MARGIN = { top: 18, right: 12, bottom: 26, left: 48 };

function axisValue(measure: PostMeasure, value: number): string {
  return measure === "avgWatchMs" ? formatWatch(value).replace(".0 s", " s") : formatCount(value);
}

/**
 * One thin bar per post, in publish order, coloured by platform. Posts without a value keep their
 * slot so the views and watch-time charts line up. Each bar is a keyboard stop with a tooltip;
 * only the tallest bar is labelled.
 */
export function PostBarsChart({
  posts,
  measure,
  title,
}: {
  posts: readonly PostPerformance[];
  measure: PostMeasure;
  title: string;
}) {
  const [ref, width] = useChartWidth<HTMLDivElement>();
  const { active, pointProps } = useChartPoints(posts.length);
  const plotWidth = Math.max(40, width - MARGIN.left - MARGIN.right);
  const values = posts.map((post) => post.metrics?.[measure] ?? null);
  const max = Math.max(0, ...values.map((value) => value ?? 0));
  const y = valueScale(max, PLOT_HEIGHT);
  const keys = posts.map((post) => post.postId);
  const layout = barLayout(keys, plotWidth);
  const ticks = y.ticks(4);
  const xTicks = tickIndices(posts.length, plotWidth, 72);
  const peak = values.indexOf(max);
  const activePost = active === null ? undefined : posts[active];

  return (
    <div ref={ref} className="relative">
      <svg
        width={width}
        height={PLOT_HEIGHT + MARGIN.top + MARGIN.bottom}
        aria-hidden="true"
        className="block overflow-visible"
      >
        <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
          <g>
            {ticks.map((tick) => (
              <g key={tick} transform={`translate(0,${y(tick)})`}>
                <line
                  x2={plotWidth}
                  stroke={tick === 0 ? "var(--viz-baseline)" : "var(--viz-grid)"}
                  strokeWidth={1}
                  shapeRendering="crispEdges"
                />
                <text
                  x={-8}
                  dy="0.32em"
                  textAnchor="end"
                  className="fill-(--viz-axis) text-[11px] tabular-nums"
                >
                  {axisValue(measure, tick)}
                </text>
              </g>
            ))}
            {xTicks.map((index) => {
              const post = posts[index];
              if (!post) return null;
              return (
                <text
                  key={post.postId}
                  x={layout.center(post.postId)}
                  y={PLOT_HEIGHT + 18}
                  textAnchor="middle"
                  className="fill-(--viz-axis) text-[11px]"
                >
                  {formatDay(Date.parse(post.publishedAt))}
                </text>
              );
            })}
          </g>

          <g>
            {posts.map((post, index) => {
              const value = values[index] ?? null;
              if (value === null || value <= 0) return null;
              const top = y(value);
              return (
                <path
                  key={post.postId}
                  d={barPath(layout.x(post.postId), top, layout.barWidth, PLOT_HEIGHT - top)}
                  fill={platformColor(post.platform)}
                  opacity={active === null || active === index ? 1 : 0.45}
                />
              );
            })}
            {peak >= 0 && max > 0 && posts[peak] ? (
              <text
                x={layout.center(posts[peak].postId)}
                y={y(max) - 6}
                textAnchor="middle"
                className="fill-(--lc-text-2) text-[11px] font-medium tabular-nums"
              >
                {measure === "avgWatchMs" ? formatWatch(max) : formatCount(max)}
              </text>
            ) : null}
          </g>
        </g>
      </svg>
      <ChartPoints
        label={`${title}, one bar per post. Arrow keys move between them.`}
        points={posts.map((post) => ({
          key: post.postId,
          label: tooltipText(postTooltip(post, measure)),
          x: MARGIN.left + layout.center(post.postId) - layout.step / 2,
          y: 0,
          width: layout.step,
          height: PLOT_HEIGHT + MARGIN.top,
        }))}
        pointProps={pointProps}
      />
      {activePost && active !== null ? (
        <ChartTooltip
          content={postTooltip(activePost, measure)}
          x={MARGIN.left + layout.center(activePost.postId)}
          y={MARGIN.top}
          width={width}
        />
      ) : null}
    </div>
  );
}

/** The per-post charts' table twin. */
export function PostBarsTable({
  posts,
  measure,
  caption,
}: {
  posts: readonly PostPerformance[];
  measure: PostMeasure;
  caption: string;
}) {
  return (
    <ChartTable
      caption={caption}
      columns={[
        { id: "title", label: "Video" },
        { id: "platform", label: "Platform" },
        { id: "published", label: "Published" },
        { id: "value", label: measure === "views" ? "Views" : "Avg. watch time", numeric: true },
      ]}
      rows={posts.map((post) => ({
        id: post.postId,
        cells: [
          post.title,
          PLATFORM_LABELS[post.platform],
          formatDay(Date.parse(post.publishedAt), true),
          postMeasure(post, measure),
        ],
      }))}
    />
  );
}
