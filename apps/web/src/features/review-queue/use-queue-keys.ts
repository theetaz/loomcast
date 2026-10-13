import { type RefObject, useEffect } from "react";

/** Whether the key press belongs to a field the user is typing in. */
function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target.closest("[role=dialog], [role=alertdialog], [role=menu], [role=listbox]")) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/**
 * `j` and `k` (and the arrow keys once a row has focus) move between the rows' links inside
 * `listRef`; Enter on a focused link opens it like any link. `j` with nothing focused starts at the
 * remembered row, so the first press lands somewhere useful. Focus moves without animation or
 * smooth scrolling: these keys are pressed many times in a row.
 */
export function useQueueKeys(
  listRef: RefObject<HTMLElement | null>,
  selector: string,
  activeIndex: number,
) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      const links = Array.from(listRef.current?.querySelectorAll<HTMLElement>(selector) ?? []);
      if (links.length === 0) return;
      const current = links.indexOf(document.activeElement as HTMLElement);
      const arrow = event.key === "ArrowDown" || event.key === "ArrowUp";
      if (arrow && current === -1) return;
      if (!arrow && isTyping(event.target)) return;

      let next: number | null = null;
      if (event.key === "j" || event.key === "ArrowDown") {
        next = current === -1 ? Math.min(activeIndex, links.length - 1) : current + 1;
      } else if (event.key === "k" || event.key === "ArrowUp") {
        next = current === -1 ? Math.min(activeIndex, links.length - 1) : current - 1;
      } else if (current !== -1 && event.key === "Home") next = 0;
      else if (current !== -1 && event.key === "End") next = links.length - 1;
      if (next === null) return;
      event.preventDefault();
      const target = links[Math.max(0, Math.min(links.length - 1, next))];
      target?.focus();
      target?.scrollIntoView({ block: "nearest" });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [listRef, selector, activeIndex]);
}
