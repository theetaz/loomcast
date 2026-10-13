import type { PostMetrics } from "@loomcast/contracts";
import { ChartTooltip } from "./ChartFrame";
import { ChartPoints } from "./ChartPoints";
import type { MetricKey } from "./format";
import { linePath, pointScale, valueScale } from "./scales";
import { captureTooltip, tooltipText } from "./tooltips";
import { useChartPoints, useChartWidth } from "./use-chart";

const HEIGHT = 32;
const PAD = 5;

/** Whether a metric has enough captures for a trend line. */
export function canSpark(history: readonly PostMetrics[], key: MetricKey): boolean {
  return history.filter((capture) => capture[key] !== null).length >= 2;
}

/**
 * A metric across a post's captures: a 2px line from a zero baseline with an end dot. One keyboard
 * stop; arrow keys walk the captures and show each one's value and time.
 */
export function Sparkline({
  history,
  metric,
  label,
  color,
}: {
  history: readonly PostMetrics[];
  metric: MetricKey;
  label: string;
  color: string;
}) {
  const [ref, width] = useChartWidth<HTMLDivElement>(160);
  const { active, pointProps } = useChartPoints(history.length);
  const values = history.map((capture) => capture[metric]);
  const max = Math.max(0, ...values.map((value) => value ?? 0));
  const plotWidth = Math.max(10, width - PAD * 2);
  const plotHeight = HEIGHT - PAD * 2;
  const x = pointScale(history.length, plotWidth);
  const y = valueScale(max, plotHeight, 1);
  const lastIndex = values.findLastIndex((value) => value !== null);
  const step = history.length > 1 ? plotWidth / (history.length - 1) : plotWidth;
  const marked = active ?? lastIndex;
  const markedValue = values[marked] ?? null;
  const activeCapture = active === null ? undefined : history[active];

  return (
    <div ref={ref} className="relative">
      <svg width={width} height={HEIGHT} aria-hidden="true" className="block overflow-visible">
        <g transform={`translate(${PAD},${PAD})`}>
          <path
            d={linePath(values, x, y)}
            fill="none"
            stroke={color}
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
          {markedValue !== null && marked >= 0 ? (
            <circle
              cx={x(marked)}
              cy={y(markedValue)}
              r={4}
              fill={color}
              stroke="var(--viz-surface)"
              strokeWidth={2}
            />
          ) : null}
        </g>
      </svg>
      <ChartPoints
        label={`${label} over ${history.length} captures. Arrow keys move between them.`}
        points={history.map((capture, index) => ({
          key: capture.capturedAt,
          label: tooltipText(captureTooltip(capture, metric, label, color)),
          x: PAD + x(index) - step / 2,
          y: 0,
          width: step,
          height: HEIGHT,
        }))}
        pointProps={pointProps}
      />
      {activeCapture && active !== null ? (
        <ChartTooltip
          content={captureTooltip(activeCapture, metric, label, color)}
          x={PAD + x(active)}
          y={HEIGHT + 4}
          width={width}
        />
      ) : null}
    </div>
  );
}
