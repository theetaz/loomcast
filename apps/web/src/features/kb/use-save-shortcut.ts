import { useEffect, useRef } from "react";

/** Whether a key event is ⌘S on macOS or Ctrl+S elsewhere. */
export function isSaveShortcut(event: KeyboardEvent): boolean {
  return (event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "s";
}

/**
 * Calls `onSave` for ⌘S or Ctrl+S anywhere on the page while the caller is mounted, instead of
 * the browser's "Save page" dialog.
 */
export function useSaveShortcut(onSave: () => void, enabled = true) {
  const saveRef = useRef(onSave);
  useEffect(() => {
    saveRef.current = onSave;
  });
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isSaveShortcut(event)) return;
      event.preventDefault();
      saveRef.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled]);
}
