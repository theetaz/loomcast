import type { useChartPoints } from "./use-chart";

export interface ChartPoint {
  key: string;
  /** The point's accessible name: the same words as its tooltip. */
  label: string;
  /** Hit area in the chart's pixel space: bigger than the mark, never only its painted pixels. */
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The keyboard and pointer layer over a chart's SVG: one transparent button per data point, in a
 * list named after the chart. The SVG itself is presentational.
 */
export function ChartPoints({
  label,
  points,
  pointProps,
}: {
  label: string;
  points: readonly ChartPoint[];
  pointProps: ReturnType<typeof useChartPoints>["pointProps"];
}) {
  return (
    <ol aria-label={label} className="absolute inset-0">
      {points.map((point, index) => (
        <li key={point.key}>
          <button
            type="button"
            aria-label={point.label}
            className="absolute cursor-default rounded-[3px] outline-none focus-visible:bg-accent-soft focus-visible:shadow-[inset_0_0_0_1px_var(--ring)]"
            style={{ left: point.x, top: point.y, width: point.width, height: point.height }}
            {...pointProps(index)}
          />
        </li>
      ))}
    </ol>
  );
}
