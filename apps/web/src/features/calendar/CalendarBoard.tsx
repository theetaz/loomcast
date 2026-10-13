import type { CalendarResponse } from "@loomcast/contracts";
import { useMemo } from "react";
import { BoardContext, type BoardContextValue } from "./board-context";
import { layoutEntries } from "./layout";
import { MonthGrid } from "./MonthGrid";
import type { CalendarPeriod } from "./time";
import { WeekGrid } from "./WeekGrid";

export interface CalendarBoardProps extends Omit<BoardContextValue, "view"> {
  period: CalendarPeriod;
  data: CalendarResponse | undefined;
}

/** The week or month grid with the period's posts and open slots. */
export function CalendarBoard({ period, data, ...context }: CalendarBoardProps) {
  const { zone } = context;
  const view = period.view;
  const cells = useMemo(
    () => layoutEntries(view, period.days, data, zone),
    [view, period.days, data, zone],
  );
  const value: BoardContextValue = { ...context, view };

  return (
    <BoardContext.Provider value={value}>
      {view === "week" ? (
        <WeekGrid period={period} cells={cells} ready={data !== undefined} />
      ) : (
        <MonthGrid period={period} cells={cells} />
      )}
    </BoardContext.Provider>
  );
}
