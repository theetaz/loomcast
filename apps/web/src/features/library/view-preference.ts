import { useCallback, useState } from "react";

export const LIBRARY_VIEWS = ["table", "board"] as const;
export type LibraryView = (typeof LIBRARY_VIEWS)[number];

/** Where the table or board choice is kept, per browser. */
export const LIBRARY_VIEW_KEY = "loomcast.library.view";

export function readLibraryView(): LibraryView {
  try {
    const stored = window.localStorage.getItem(LIBRARY_VIEW_KEY);
    return stored === "board" ? "board" : "table";
  } catch {
    return "table";
  }
}

/** The table or board view, remembered across visits. */
export function useLibraryView(): [LibraryView, (view: LibraryView) => void] {
  const [view, setView] = useState<LibraryView>(readLibraryView);
  const change = useCallback((next: LibraryView) => {
    setView(next);
    try {
      window.localStorage.setItem(LIBRARY_VIEW_KEY, next);
    } catch {
      // Storage can be full or blocked; the choice still holds for this visit.
    }
  }, []);
  return [view, change];
}
