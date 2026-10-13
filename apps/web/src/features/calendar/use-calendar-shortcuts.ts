import { type RefObject, useEffect, useRef } from "react";

export interface CalendarShortcuts {
  onPrevious: () => void;
  onNext: () => void;
  onToday: () => void;
}

/** Places where arrows and letters belong to the control: fields, menus, dialogs and tab lists. */
const OWN_KEYS =
  'input, textarea, select, [contenteditable="true"], [role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [role="tablist"], [role="combobox"]';

/**
 * `←` and `→` change the period and `t` jumps to today. Quiet while a post is being dragged (the
 * arrows move it), while typing and inside menus and dialogs.
 */
export function useCalendarShortcuts(
  shortcuts: CalendarShortcuts,
  draggingRef: RefObject<boolean>,
) {
  const latest = useRef(shortcuts);
  latest.current = shortcuts;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      if (draggingRef.current) return;
      const target = event.target;
      if (target instanceof Element && target.closest(OWN_KEYS)) return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"]')) return;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        latest.current.onPrevious();
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        latest.current.onNext();
      } else if (event.key === "t" || event.key === "T") {
        event.preventDefault();
        latest.current.onToday();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [draggingRef]);
}
