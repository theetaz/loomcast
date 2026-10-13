import { ChartTable, ChartTooltip } from "./ChartFrame";
import { ChartPoints } from "./ChartPoints";
import { formatCount, formatFullCount } from "./format";
import { PLATFORM_LABELS, platformColor } from "./platforms";
import { linePath, pointScale, tickIndices, type ViewsTrend, valueScale } from "./scales";
import { tooltipText, trendTooltip } from "./tooltips";
import { useChartPoints, useChartWidth } from "./use-chart";

const PLOT_HEIGHT = 220;
const MARGIN = { top: 10, right: 16, bottom: 26, left: 44 };
/** Room for direct labels at the line ends. */
const LABEL_ROOM = 74;
/** End labels closer than this would collide; the legend carries identity instead. */
const LABEL_MIN_GAP = 14;

/**
 * Views per platform over the range, one 2px line per platform from a zero baseline. A crosshair
 * snaps to the nearest bucket; every bucket is a keyboard stop with the same readout.
 */
export function ViewsTrendChart({ trend, title }: { trend: ViewsTrend; title: string }) {
  const [ref, width] = useChartWidth<HTMLDivElement>();
  const count = trend.buckets.length;
  const { active, pointProps } = useChartPoints(count);

  const max = Math.max(
    0,
    ...trend.lines.flatMap((line) => line.values.map((value) => value.total)),
  );
  const y = valueScale(max, PLOT_HEIGHT);
  const ends = trend.lines.map((line) => ({
    platform: line.platform,
    y: y(line.values.at(-1)?.total ?? 0),
  }));
  const sortedEnds = [...ends].sort((a, b) => a.y - b.y);
  const labelsFit =
    trend.lines.length > 1 &&
    width >= 420 &&
    sortedEnds.every(
      (end, index) => index === 0 || end.y - (sortedEnds[index - 1]?.y ?? 0) >= LABEL_MIN_GAP,
    );
  const right = MARGIN.right + (labelsFit ? LABEL_ROOM : 0);
  const plotWidth = Math.max(40, width - MARGIN.left - right);
  const x = pointScale(count, plotWidth);
  const step = count > 1 ? plotWidth / (count - 1) : plotWidth;
  const ticks = y.ticks(4);
  const xTicks = tickIndices(count, plotWidth, 64);
  const tooltip = active === null ? null : trendTooltip(trend, active);

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
                  {formatCount(tick)}
                </text>
              </g>
            ))}
            {xTicks.map((index) => (
              <text
                key={index}
                x={x(index)}
                y={PLOT_HEIGHT + 18}
                textAnchor={
                  index === 0 && count > 1 ? "start" : index === count - 1 ? "end" : "middle"
                }
                className="fill-(--viz-axis) text-[11px]"
              >
                {trend.buckets[index]?.tick}
              </text>
            ))}
          </g>

          <g fill="none" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round">
            {trend.lines.map((line) => (
              <path
                key={line.platform}
                d={linePath(
                  line.values.map((value) => value.total),
                  x,
                  y,
                )}
                stroke={platformColor(line.platform)}
              />
            ))}
          </g>

          {labelsFit ? (
            <g>
              {ends.map((end) => (
                <text
                  key={end.platform}
                  x={plotWidth + 8}
                  y={end.y}
                  dy="0.32em"
                  className="fill-(--lc-text-2) text-[11px]"
                >
                  {PLATFORM_LABELS[end.platform]}
                </text>
              ))}
            </g>
          ) : null}

          {active !== null ? (
            <g pointerEvents="none">
              <line
                x1={x(active)}
                x2={x(active)}
                y2={PLOT_HEIGHT}
                stroke="var(--viz-crosshair)"
                strokeWidth={1}
                shapeRendering="crispEdges"
              />
              {trend.lines.map((line) => (
                <circle
                  key={line.platform}
                  cx={x(active)}
                  cy={y(line.values[active]?.total ?? 0)}
                  r={4}
                  fill={platformColor(line.platform)}
                  stroke="var(--viz-surface)"
                  strokeWidth={2}
                />
              ))}
            </g>
          ) : null}
        </g>
      </svg>
      <ChartPoints
        label={`${title}, by ${trend.granularity}. Arrow keys move between them.`}
        points={trend.buckets.map((bucket, index) => ({
          key: String(bucket.start),
          label: tooltipText(trendTooltip(trend, index)),
          x: MARGIN.left + x(index) - step / 2,
          y: MARGIN.top,
          width: step,
          height: PLOT_HEIGHT,
        }))}
        pointProps={pointProps}
      />
      {tooltip && active !== null ? (
        <ChartTooltip
          content={tooltip}
          x={MARGIN.left + x(active)}
          y={MARGIN.top + 4}
          width={width}
        />
      ) : null}
    </div>
  );
}

/** The trend's table twin: per bucket and platform, the plotted total, what it added, its posts. */
export function ViewsTrendTable({ trend, caption }: { trend: ViewsTrend; caption: string }) {
  return (
    <ChartTable
      caption={caption}
      columns={[
        {
          id: "bucket",
          label:
            trend.granularity === "day" ? "Day" : trend.granularity === "week" ? "Week" : "Month",
        },
        ...trend.lines.flatMap((line) => [
          {
            id: `${line.platform}-total`,
            label: `${PLATFORM_LABELS[line.platform]} total`,
            numeric: true,
          },
          { id: `${line.platform}-added`, label: "Added", numeric: true },
          { id: `${line.platform}-posts`, label: "Posts", numeric: true },
        ]),
      ]}
      rows={trend.buckets.map((bucket, index) => ({
        id: String(bucket.start),
        cells: [
          bucket.label,
          ...trend.lines.flatMap((line) => {
            const value = line.values[index] ?? { views: 0, posts: 0, total: 0 };
            return [
              formatFullCount(value.total),
              formatFullCount(value.views),
              formatFullCount(value.posts),
            ];
          }),
        ],
      }))}
    />
  );
}
