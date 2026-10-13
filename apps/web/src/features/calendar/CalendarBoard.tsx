import {
  type Announcements,
  type CollisionDetection,
  DndContext,
  type DragEndEvent,
  type DragOverEvent,
  DragOverlay,
  type DragStartEvent,
  KeyboardCode,
  type KeyboardCoordinateGetter,
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  rectIntersection,
  TouchSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import type { CalendarResponse, ScheduledPost } from "@loomcast/contracts";
import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { BoardContext, type BoardContextValue, type DragState } from "./board-context";
import type { DropData } from "./DropCell";
import { layoutEntries, startTarget } from "./layout";
import { MonthGrid } from "./MonthGrid";
import { LiftedChip } from "./PostChip";
import { useReschedulePost } from "./queries";
import {
  type CalendarPeriod,
  type CellTarget,
  isArrowKey,
  longDayLabel,
  placeInstant,
  stepTarget,
  targetId,
  targetInstant,
  targetTime,
} from "./time";
import { WeekGrid } from "./WeekGrid";

/** Mouse and pen drags; touch has its own sensor with a press-and-hold, so swipes still scroll. */
class FinePointerSensor extends PointerSensor {
  static override activators = [
    {
      eventName: "onPointerDown" as const,
      handler: ({ nativeEvent }: ReactPointerEvent) =>
        nativeEvent.pointerType !== "touch" && nativeEvent.isPrimary && nativeEvent.button === 0,
    },
  ];
}

/** Space picks up and drops; Escape and Tab cancel. Enter opens the video when not dragging. */
const KEYBOARD_CODES = {
  start: [KeyboardCode.Space],
  cancel: [KeyboardCode.Esc, KeyboardCode.Tab],
  end: [KeyboardCode.Space, KeyboardCode.Enter],
};

/** No animation for keyboard moves: the copy never slides, and drops land at once. */
const NO_TRANSITION = () => undefined;

const INSTRUCTIONS =
  "To move a post, press Space to pick it up. Use the arrow keys to move it by half an hour or a day " +
  "(a day or a week in the month view), then press Space to drop it or Escape to cancel. " +
  "Press Enter to open its video.";

export interface CalendarBoardProps extends Omit<BoardContextValue, "drag" | "saving" | "view"> {
  period: CalendarPeriod;
  data: CalendarResponse | undefined;
  /** Told when a drag starts and ends, so page shortcuts stay quiet meanwhile. */
  onDraggingChange?: (dragging: boolean) => void;
}

function postOf(data: unknown): ScheduledPost | null {
  const post = (data as { post?: ScheduledPost } | undefined)?.post;
  return post ?? null;
}

function dropOf(data: unknown): DropData | null {
  const drop = data as DropData | undefined;
  return drop?.target ? drop : null;
}

/**
 * The week or month grid with drag and drop. Pointer drags lift a copy of the post that follows
 * the pointer; keyboard drags move a marker from cell to cell without any animation. Dropping
 * moves the post at once and saves it; a refused move puts it back.
 */
export function CalendarBoard({ period, data, onDraggingChange, ...context }: CalendarBoardProps) {
  const { zone, earliestMs } = context;
  const view = period.view;
  const reschedule = useReschedulePost();
  const [drag, setDragState] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const [saving, setSaving] = useState<ReadonlySet<string>>(() => new Set());
  /** After a keyboard drag: the post to focus again, and the cell it is expected in. */
  const [refocus, setRefocus] = useState<{ postId: string; cell: string } | null>(null);
  /** Set while a keyboard drag has not left its starting cell yet. */
  const keyboardStart = useRef(false);

  const setDrag = useCallback(
    (next: DragState | null) => {
      const wasDragging = dragRef.current !== null;
      dragRef.current = next;
      setDragState(next);
      if (wasDragging !== (next !== null)) onDraggingChange?.(next !== null);
    },
    [onDraggingChange],
  );

  const cells = useMemo(
    () => layoutEntries(view, period.days, data, zone),
    [view, period.days, data, zone],
  );

  // Arrow keys move the marker by slot or day; the sensor only needs to know the key was used.
  const coordinateGetter: KeyboardCoordinateGetter = useCallback(
    (event, { currentCoordinates }) => {
      const current = dragRef.current;
      if (!current || !isArrowKey(event.code)) return undefined;
      event.preventDefault();
      const from = current.target ?? startTarget(view, current.post, period.days, zone);
      if (!from) return currentCoordinates;
      setDrag({ ...current, target: stepTarget(view, from, event.code, period.days) });
      return currentCoordinates;
    },
    [view, period.days, zone, setDrag],
  );

  const sensors = useSensors(
    useSensor(FinePointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
    useSensor(KeyboardSensor, {
      keyboardCodes: KEYBOARD_CODES,
      coordinateGetter,
      scrollBehavior: "auto",
    }),
  );

  // Keyboard drags land where the marker is, not where geometry says; pointer drags use the pointer.
  const keyboardTarget = drag?.mode === "keyboard" ? drag.target : null;
  const collisionDetection: CollisionDetection = useCallback(
    (args) => {
      if (dragRef.current?.mode === "keyboard") {
        return keyboardTarget ? [{ id: targetId(keyboardTarget) }] : [];
      }
      const within = pointerWithin(args);
      return within.length > 0 ? within : rectIntersection(args);
    },
    [keyboardTarget],
  );

  const describe = useCallback(
    (post: ScheduledPost, target: CellTarget | null) => {
      if (!target) {
        const place = placeInstant(post.scheduledAt, zone);
        return `${longDayLabel(place.day)}, ${place.time}`;
      }
      return `${longDayLabel(target.day)}, ${targetTime(target, post.scheduledAt, zone)}`;
    },
    [zone],
  );

  const announcements: Announcements = useMemo(
    () => ({
      onDragStart: ({ active }) => {
        const post = postOf(active.data.current);
        return post
          ? `Picked up ${post.item.title}, at ${describe(post, null)}.`
          : "Picked up a post.";
      },
      onDragOver: ({ active, over }) => {
        const post = postOf(active.data.current);
        const drop = dropOf(over?.data.current);
        if (!post) return undefined;
        // A keyboard drag starts over the post's own cell: "picked up" already said where it is.
        const start = startTarget(view, post, period.days, zone);
        if (drop && start && targetId(drop.target) === targetId(start) && keyboardStart.current) {
          keyboardStart.current = false;
          return undefined;
        }
        return drop
          ? `${post.item.title} is over ${describe(post, drop.target)}.`
          : `${post.item.title} is not over a time.`;
      },
      onDragEnd: ({ active, over }) => {
        const post = postOf(active.data.current);
        const drop = dropOf(over?.data.current);
        if (!post) return undefined;
        if (!drop) return `${post.item.title} stays at ${describe(post, null)}.`;
        const at = targetInstant(drop.target, post.scheduledAt, zone).getTime();
        if (at < earliestMs) {
          return `${post.item.title} can't move into the past or the next two minutes. It stays at ${describe(post, null)}.`;
        }
        return `${post.item.title} moved to ${describe(post, drop.target)}.`;
      },
      onDragCancel: ({ active }) => {
        const post = postOf(active.data.current);
        return post
          ? `Moving cancelled. ${post.item.title} stays at ${describe(post, null)}.`
          : "Moving cancelled.";
      },
    }),
    [describe, earliestMs, zone, view, period.days],
  );

  const onDragStart = ({ active, activatorEvent }: DragStartEvent) => {
    const post = postOf(active.data.current);
    if (!post) return;
    const keyboard = activatorEvent instanceof KeyboardEvent;
    keyboardStart.current = keyboard;
    setDrag({
      post,
      mode: keyboard ? "keyboard" : "pointer",
      target: keyboard ? startTarget(view, post, period.days, zone) : null,
    });
  };

  const onDragOver = ({ over }: DragOverEvent) => {
    const current = dragRef.current;
    if (current?.mode !== "pointer") return;
    setDrag({ ...current, target: dropOf(over?.data.current)?.target ?? null });
  };

  const onDragEnd = ({ over }: DragEndEvent) => {
    const current = dragRef.current;
    setDrag(null);
    if (!current) return;
    const target =
      current.mode === "keyboard" ? current.target : (dropOf(over?.data.current)?.target ?? null);
    const { post } = current;
    const at = target ? targetInstant(target, post.scheduledAt, zone) : null;
    const moves =
      target !== null &&
      at !== null &&
      at.getTime() !== Date.parse(post.scheduledAt) &&
      at.getTime() >= earliestMs;
    if (current.mode === "keyboard") {
      setRefocus({ postId: post.id, cell: moves && target ? targetId(target) : "" });
    }
    if (!target || !at || at.getTime() === Date.parse(post.scheduledAt)) return;
    if (!moves) {
      toast.error("Pick a later time", {
        description: "Posts can be moved to at least two minutes from now.",
      });
      return;
    }
    setSaving((ids) => new Set(ids).add(post.id));
    reschedule.mutate(
      { post, scheduledAt: at.toISOString() },
      {
        onSettled: () =>
          setSaving((ids) => {
            const next = new Set(ids);
            next.delete(post.id);
            return next;
          }),
      },
    );
  };

  const onDragCancel = () => {
    const current = dragRef.current;
    setDrag(null);
    if (current?.mode === "keyboard") setRefocus({ postId: current.post.id, cell: "" });
  };

  // A keyboard move can leave the visible part of the grid: bring the marker along, instantly.
  const keyboardTargetId = keyboardTarget ? targetId(keyboardTarget) : null;
  useEffect(() => {
    if (!keyboardTargetId) return;
    document
      .querySelector(`[data-cell="${keyboardTargetId}"]`)
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [keyboardTargetId]);

  // After a keyboard drop the chip re-mounts in its new cell: give it focus back once it is there
  // (or wherever it settled, if the move was refused).
  useEffect(() => {
    if (!refocus) return;
    const chip = document.querySelector<HTMLElement>(`[data-post-chip="${refocus.postId}"]`);
    if (!chip) return;
    const cell = chip.closest<HTMLElement>("[data-cell]")?.dataset.cell;
    if (cell !== refocus.cell && saving.has(refocus.postId)) return;
    if (document.activeElement !== chip) chip.focus();
    setRefocus(null);
  });

  const value: BoardContextValue = { ...context, view, drag, saving };
  const overlayPost = drag?.mode === "pointer" ? drag.post : null;

  return (
    <BoardContext.Provider value={value}>
      <DndContext
        sensors={sensors}
        collisionDetection={collisionDetection}
        accessibility={{
          announcements,
          screenReaderInstructions: { draggable: INSTRUCTIONS },
        }}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragEnd={onDragEnd}
        onDragCancel={onDragCancel}
      >
        {view === "week" ? (
          <WeekGrid period={period} cells={cells} ready={data !== undefined} />
        ) : (
          <MonthGrid period={period} cells={cells} />
        )}
        <DragOverlay dropAnimation={null} transition={NO_TRANSITION} zIndex={60}>
          {overlayPost ? (
            <LiftedChip
              post={overlayPost}
              time={placeInstant(overlayPost.scheduledAt, zone).time}
              compact={view === "month"}
            />
          ) : null}
        </DragOverlay>
      </DndContext>
    </BoardContext.Provider>
  );
}
