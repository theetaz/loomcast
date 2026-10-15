import { ScrollArea } from "@loomcast/ui/components/scroll-area";
import { cn } from "@loomcast/ui/lib/cn";
import { useBoard } from "./board-context";
import { DropCell } from "./DropCell";
import { type CalendarEntry, monthOverflow } from "./layout";
import { OpenSlot } from "./OpenSlot";
import { PostChip } from "./PostChip";
import { type CalendarPeriod, longDayLabel, shortDayLabel, targetId, WEEKDAY_LABELS } from "./time";

/** Six weeks around the month. Each day shows up to three entries, then "+n more". */
export function MonthGrid({
  period,
  cells,
}: {
  period: CalendarPeriod;
  cells: Map<string, CalendarEntry[]>;
}) {
  const { today, onShowDay } = useBoard();

  return (
    <ScrollArea orientation="horizontal">
      <div className="grid min-w-[560px] grid-cols-7">
        {WEEKDAY_LABELS.map((weekday) => (
          <div
            key={weekday}
            className="border-divider border-b px-2 py-2 text-small text-muted-foreground [&:not(:first-child)]:border-l"
          >
            {weekday}
          </div>
        ))}
        {period.days.map((day, index) => {
          const target = { day, row: null };
          const { shown, hidden } = monthOverflow(cells.get(targetId(target)) ?? []);
          const inMonth = day.startsWith(period.month);
          const isToday = day === today;
          return (
            <DropCell
              key={day}
              target={target}
              label={longDayLabel(day)}
              disabled={day < today}
              className={cn(
                "flex min-h-[112px] flex-col gap-1 border-divider p-1.5",
                index % 7 !== 0 && "border-l",
                index < period.days.length - 7 && "border-b",
              )}
            >
              <span
                className={cn(
                  "flex h-5.5 items-center self-start px-1 font-medium text-small tabular-nums",
                  isToday &&
                    "min-w-5.5 justify-center rounded-full bg-primary text-primary-foreground",
                  !isToday && (inMonth ? "text-foreground" : "text-text-4"),
                )}
              >
                <span className="sr-only">{longDayLabel(day)}</span>
                <span aria-hidden="true">{shortDayLabel(day).date}</span>
              </span>
              {shown.map((entry) =>
                entry.kind === "post" ? (
                  <PostChip key={entry.key} post={entry.post} day={day} time={entry.time} compact />
                ) : (
                  <OpenSlot key={entry.key} slot={entry.slot} day={day} time={entry.time} compact />
                ),
              )}
              {hidden > 0 ? (
                <button
                  type="button"
                  onClick={() => onShowDay(day)}
                  aria-label={`${hidden} more on ${longDayLabel(day)}. Show the week.`}
                  className="self-start rounded-sm px-1 font-medium text-[11.5px] text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                >
                  +{hidden} more
                </button>
              ) : null}
            </DropCell>
          );
        })}
      </div>
    </ScrollArea>
  );
}
