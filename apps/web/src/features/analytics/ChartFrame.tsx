import { Tabs, TabsContent, TabsList, TabsTrigger } from "@loomcast/ui/components/tabs";
import { cn } from "@loomcast/ui/lib/cn";
import { ChartNoAxesColumnIcon, ChartSplineIcon, Rows3Icon } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import type { TooltipContent } from "./tooltips";
import "./viz.css";

export type ChartView = "chart" | "table";

/** Why a chart shows a message instead of marks. Its table view still lists what there is. */
export interface ChartNotice {
  title: string;
  description?: ReactNode;
}

export interface ChartFrameProps {
  title: string;
  description?: ReactNode;
  /** Shown above the plot; omit it for a single series, which the title already names. */
  legend?: ReactNode;
  chart: ReactNode;
  table: ReactNode;
  /** Replaces the chart (never the table) with "not enough data yet" and similar. */
  notice?: ChartNotice | null;
  /** Holds the previous render, dimmed, while new numbers load. */
  busy?: boolean;
  /** `line` or `bars`, for the toggle's icon. */
  kind?: "line" | "bars";
  className?: string;
}

/**
 * A chart card: title, description, legend, and a Chart / Table toggle so every chart has an
 * accessible table twin with the same values.
 */
export function ChartFrame({
  title,
  description,
  legend,
  chart,
  table,
  notice,
  busy = false,
  kind = "line",
  className,
}: ChartFrameProps) {
  const [view, setView] = useState<ChartView>("chart");
  const titleId = useId();
  const ChartIcon = kind === "line" ? ChartSplineIcon : ChartNoAxesColumnIcon;
  return (
    <section
      aria-labelledby={titleId}
      aria-busy={busy || undefined}
      className={cn("lc-viz rounded-lg bg-card shadow-card", className)}
    >
      <Tabs value={view} onValueChange={(value) => setView(value as ChartView)} className="gap-0">
        <div className="flex flex-wrap items-start gap-x-3 gap-y-2 px-4 pt-3.5">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <h2 id={titleId} className="text-heading text-foreground">
              {title}
            </h2>
            {description ? (
              <p className="text-small text-muted-foreground text-pretty">{description}</p>
            ) : null}
          </div>
          <TabsList aria-label={`Show ${title.toLowerCase()} as`}>
            <TabsTrigger value="chart" className="flex-none">
              <ChartIcon aria-hidden="true" />
              Chart
            </TabsTrigger>
            <TabsTrigger value="table" className="flex-none">
              <Rows3Icon aria-hidden="true" />
              Table
            </TabsTrigger>
          </TabsList>
        </div>
        <div
          className={cn(
            "transition-opacity duration-150 ease-out motion-reduce:transition-none",
            busy && "opacity-60",
          )}
        >
          <TabsContent value="chart" tabIndex={-1} className="px-4 pt-3 pb-4">
            {notice ? (
              <ChartMessage notice={notice} />
            ) : (
              <>
                {legend}
                {chart}
              </>
            )}
          </TabsContent>
          <TabsContent value="table" tabIndex={-1} className="pt-3 pb-1">
            {table}
          </TabsContent>
        </div>
      </Tabs>
    </section>
  );
}

/** "Not enough data yet" and friends, in the space the chart would take. */
export function ChartMessage({ notice, className }: { notice: ChartNotice; className?: string }) {
  return (
    <div
      className={cn(
        "flex min-h-[180px] flex-col items-center justify-center gap-1 rounded-md bg-secondary px-6 py-8 text-center",
        className,
      )}
    >
      <p className="text-control font-medium text-foreground">{notice.title}</p>
      {notice.description ? (
        <p className="max-w-sm text-small text-muted-foreground text-pretty">
          {notice.description}
        </p>
      ) : null}
    </div>
  );
}

export interface LegendEntry {
  id: string;
  label: string;
  color: string;
  /** A figure after the label, such as the series total. */
  detail?: string;
}

/** Series keys: a short line for line charts, a square for bars. Text stays in text colours. */
export function Legend({
  entries,
  mark = "line",
}: {
  entries: readonly LegendEntry[];
  mark?: "line" | "square";
}) {
  return (
    <ul aria-label="Legend" className="mb-2 flex flex-wrap gap-x-4 gap-y-1">
      {entries.map((entry) => (
        <li key={entry.id} className="flex items-center gap-1.5 text-small text-text-2">
          <span
            aria-hidden="true"
            className={cn(
              "shrink-0",
              mark === "line" ? "h-0.5 w-3 rounded-full" : "size-2 rounded-[2px]",
            )}
            style={{ background: entry.color }}
          />
          {entry.label}
          {entry.detail ? (
            <span className="text-muted-foreground tabular-nums">{entry.detail}</span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/**
 * The tooltip of the active point, placed beside `x`. It repeats
 * the point's accessible name, so it is hidden from assistive technology.
 */
export function ChartTooltip({
  content,
  x,
  y,
  width,
}: {
  content: TooltipContent;
  x: number;
  y: number;
  width: number;
}) {
  // Flip before the right edge, unless the chart is too narrow for that to help.
  const flip = x > 200 && x > width - 200;
  return (
    <div
      aria-hidden="true"
      data-testid="chart-tooltip"
      className="pointer-events-none absolute z-10 w-max max-w-[240px] rounded-md bg-popover px-2.5 py-2 text-small shadow-pop"
      style={
        flip
          ? { right: Math.max(0, width - x + 12), top: y }
          : { left: Math.max(0, x + 12), top: y }
      }
    >
      <p className="mb-1 truncate text-muted-foreground">{content.title}</p>
      <ul className="flex flex-col gap-0.5">
        {content.rows.map((row) => (
          <li key={row.id} className="flex items-center gap-2">
            <span className="h-0.5 w-3 shrink-0 rounded-full" style={{ background: row.color }} />
            <span className="font-semibold text-foreground tabular-nums">{row.value}</span>
            <span className="truncate text-muted-foreground">{row.label}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A plain table for a chart's table view. */
export function ChartTable({
  caption,
  columns,
  rows,
}: {
  caption: string;
  columns: readonly { id: string; label: string; numeric?: boolean }[];
  rows: readonly { id: string; cells: readonly ReactNode[] }[];
}) {
  return (
    <div className="relative max-h-[360px] overflow-auto">
      <table className="w-full border-collapse text-control">
        <caption className="sr-only">{caption}</caption>
        <thead className="sticky top-0 bg-card">
          <tr className="border-divider border-b">
            {columns.map((column) => (
              <th
                key={column.id}
                scope="col"
                className={cn(
                  "h-8 px-4 font-medium text-muted-foreground text-small whitespace-nowrap",
                  column.numeric ? "text-right" : "text-left",
                )}
              >
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className="border-divider border-b last:border-b-0">
              {row.cells.map((cell, index) => {
                const column = columns[index];
                const Cell = index === 0 ? "th" : "td";
                return (
                  <Cell
                    key={column?.id ?? index}
                    scope={index === 0 ? "row" : undefined}
                    className={cn(
                      "h-8 px-4 font-normal",
                      column?.numeric ? "text-right tabular-nums" : "text-left",
                      index === 0 ? "text-foreground" : "text-text-2",
                    )}
                  >
                    {cell}
                  </Cell>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
