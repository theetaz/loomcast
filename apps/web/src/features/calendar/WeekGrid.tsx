import { ScrollArea } from "@loomcast/ui/components/scroll-area";
import { cn } from "@loomcast/ui/lib/cn";
import { Fragment, useEffect, useMemo, useRef } from "react";
import { useBoard } from "./board-context";
import { DropCell } from "./DropCell";
import { type CalendarEntry, earlyLaneId, hasEarlyEntries } from "./layout";
import { OpenSlot } from "./OpenSlot";
import { PostChip } from "./PostChip";
import {
  type CalendarPeriod,
  cellInstant,
  longDayLabel,
  placeInstant,
  rowTime,
  SLOT_MINUTES,
  shortDayLabel,
  targetId,
  WEEK_ROWS,
} from "./time";

const ROWS = Array.from({ length: WEEK_ROWS }, (_, row) => row);
const SLOT_MS = SLOT_MINUTES * 60_000;
const COLUMNS = { gridTemplateColumns: "52px repeat(7, minmax(0, 1fr))" };
/** The row a week without entries opens at: 08:00. */
const FIRST_VISIBLE_ROW = 4;

/** The earliest row with an entry (but no later than `fallback` when there is none). */
function firstEntryRow(cells: Map<string, CalendarEntry[]>, fallback: number): number {
  let first = Number.POSITIVE_INFINITY;
  for (const key of cells.keys()) {
    const row = Number(key.split(":")[2]);
    if (key.startsWith("cell:") && row < first) first = row;
  }
  return Number.isFinite(first) ? Math.max(0, first - 1) : fallback;
}

/** Seven days from 06:00 to midnight in half-hour rows; posts before 06:00 get a lane on top. */
export function WeekGrid({
  period,
  cells,
  ready,
}: {
  period: CalendarPeriod;
  cells: Map<string, CalendarEntry[]>;
  /** Whether the period's posts have loaded, so the first scroll can find them. */
  ready: boolean;
}) {
  const { zone, now, today, earliestMs } = useBoard();
  const early = hasEarlyEntries(cells);

  // Each cell's start, once per period and zone: the grid re-renders on every drag step.
  const starts = useMemo(() => {
    const map = new Map<string, number>();
    for (const day of period.days) {
      for (const row of ROWS) map.set(`${day}:${row}`, cellInstant(day, row, zone).getTime());
    }
    return map;
  }, [period.days, zone]);

  const nowPlace = useMemo(() => placeInstant(new Date(now), zone), [now, zone]);
  const nowMinuteFraction = (Number(nowPlace.time.slice(3, 5)) % SLOT_MINUTES) / SLOT_MINUTES;

  const scroller = useRef<HTMLDivElement>(null);
  // Each new week opens at its first entry, or at 08:00 when it has none (the early lane, when
  // shown, sits on top already). Rows grow with their chips, so the offset is measured.
  const firstRow = early ? 0 : firstEntryRow(cells, FIRST_VISIBLE_ROW);
  const scrolledFor = useRef<string | null>(null);
  useEffect(() => {
    const container = scroller.current;
    if (!container || !ready || scrolledFor.current === period.from) return;
    scrolledFor.current = period.from;
    const row = container.querySelector<HTMLElement>(`[data-row="${firstRow}"]`);
    const header = container.querySelector<HTMLElement>("[data-week-header]");
    if (!row) return;
    const offset =
      row.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
    // The lane for posts before 06:00 sits at the top: show it from the start.
    container.scrollTop = early ? 0 : Math.max(0, offset - (header?.offsetHeight ?? 0) - 12);
  }, [period.from, firstRow, ready, early]);

  return (
    <ScrollArea
      orientation="both"
      viewportRef={scroller}
      viewportClassName="max-h-[calc(100dvh-232px)] min-h-[420px]"
    >
      <div className="grid min-w-[760px]" style={COLUMNS}>
        <div
          data-week-header
          className="sticky top-0 left-0 z-30 border-divider border-b bg-card"
        />
        {period.days.map((day) => {
          const label = shortDayLabel(day);
          const isToday = day === today;
          return (
            <div
              key={day}
              className="sticky top-0 z-20 flex items-baseline gap-1.5 border-divider border-b border-l bg-card px-2 py-2"
            >
              <span className="sr-only">{longDayLabel(day)}</span>
              <span aria-hidden="true" className="text-small text-muted-foreground">
                {label.weekday}
              </span>
              <span
                aria-hidden="true"
                className={cn(
                  "font-medium text-control tabular-nums",
                  isToday
                    ? "flex size-5.5 items-center justify-center rounded-full bg-primary text-primary-foreground"
                    : "text-foreground",
                )}
              >
                {label.date}
              </span>
            </div>
          );
        })}

        {early ? (
          <>
            <div className="sticky left-0 z-10 border-divider border-b bg-card px-1.5 py-1.5 text-right text-[10.5px] text-muted-foreground leading-tight">
              Before 6:00
            </div>
            {period.days.map((day) => (
              <div
                key={day}
                className="flex min-w-0 flex-col gap-1 border-divider border-b border-l bg-secondary/30 p-1"
              >
                <Entries day={day} entries={cells.get(earlyLaneId(day))} />
              </div>
            ))}
          </>
        ) : null}

        {ROWS.map((row) => {
          const onHour = row % 2 === 0;
          return (
            <Fragment key={row}>
              <div
                data-row={row}
                className={cn(
                  "sticky left-0 z-10 bg-card pr-2 text-right font-mono text-[10.5px] text-muted-foreground tabular-nums",
                  onHour ? "border-transparent" : "border-divider border-b",
                )}
              >
                {onHour ? <span className="relative -top-[7px]">{rowTime(row)}</span> : null}
              </div>
              {period.days.map((day) => {
                const target = { day, row };
                const start = starts.get(`${day}:${row}`) ?? 0;
                const id = targetId(target);
                const showsNow = day === today && nowPlace.row === row;
                return (
                  <DropCell
                    key={day}
                    target={target}
                    label={`${longDayLabel(day)}, ${rowTime(row)}`}
                    disabled={start + SLOT_MS <= earliestMs}
                    className={cn(
                      "flex min-h-8 flex-col gap-1 border-divider border-b border-l p-1",
                      onHour && "[border-bottom-style:dashed]",
                    )}
                  >
                    {showsNow ? (
                      <span
                        aria-hidden="true"
                        className="pointer-events-none absolute right-0 left-0 z-[1] h-0.5 bg-ember"
                        style={{ top: `${nowMinuteFraction * 100}%` }}
                      />
                    ) : null}
                    <Entries day={day} entries={cells.get(id)} />
                  </DropCell>
                );
              })}
            </Fragment>
          );
        })}
      </div>
    </ScrollArea>
  );
}

function Entries({ day, entries }: { day: string; entries: CalendarEntry[] | undefined }) {
  if (!entries) return null;
  return (
    <>
      {entries.map((entry) =>
        entry.kind === "post" ? (
          <PostChip key={entry.key} post={entry.post} day={day} time={entry.time} />
        ) : (
          <OpenSlot key={entry.key} slot={entry.slot} day={day} time={entry.time} />
        ),
      )}
    </>
  );
}
