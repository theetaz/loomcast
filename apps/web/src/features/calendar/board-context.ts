import type { Channel, ScheduledPost, Series } from "@loomcast/contracts";
import { createContext, useContext } from "react";
import type { CalendarView } from "./search";
import type { CellTarget } from "./time";

/** How the current drag started: pointer drags lift and follow the pointer, keyboard drags jump. */
export type DragMode = "pointer" | "keyboard";

export interface DragState {
  post: ScheduledPost;
  mode: DragMode;
  /** The cell the post would land in; null while over nothing. */
  target: CellTarget | null;
}

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
  drag: DragState | null;
  /** Posts whose move is still being saved; they wait before moving again. */
  saving: ReadonlySet<string>;
  onOpenPost: (post: ScheduledPost) => void;
  onShowDay: (day: string) => void;
}

export const BoardContext = createContext<BoardContextValue | null>(null);

export function useBoard(): BoardContextValue {
  const value = useContext(BoardContext);
  if (!value) throw new Error("useBoard must be used inside the calendar board.");
  return value;
}
