import type { Channel, ScheduledPost, Series } from "@loomcast/contracts";
import { createContext, useContext } from "react";
import type { CalendarView } from "./search";

/** What every cell and chip of the board reads. */
export interface BoardContextValue {
  view: CalendarView;
  zone: string;
  /** Posts and slots before this instant cannot be scheduled. */
  earliestMs: number;
  now: number;
  today: string;
  channels: Map<string, Channel>;
  series: Map<string, Series>;
  onOpenPost: (post: ScheduledPost) => void;
  onShowDay: (day: string) => void;
}

export const BoardContext = createContext<BoardContextValue | null>(null);

export function useBoard(): BoardContextValue {
  const value = useContext(BoardContext);
  if (!value) throw new Error("useBoard must be used inside the calendar board.");
  return value;
}
