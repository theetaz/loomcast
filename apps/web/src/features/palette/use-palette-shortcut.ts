import { useEffect, useRef } from "react";

export const IS_MAC =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);

/** ⌘K on Apple devices and Ctrl+K elsewhere (either works everywhere). */
export function isPaletteShortcut(event: KeyboardEvent): boolean {
  return (
    event.key.toLowerCase() === "k" &&
    (event.metaKey || event.ctrlKey) &&
    !event.altKey &&
    !event.shiftKey
  );
}

/** Calls `onToggle` for the palette shortcut anywhere in the page, before the browser does. */
export function usePaletteShortcut(onToggle: () => void) {
  const handler = useRef(onToggle);
  handler.current = onToggle;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isPaletteShortcut(event)) return;
      event.preventDefault();
      if (!event.repeat) handler.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
