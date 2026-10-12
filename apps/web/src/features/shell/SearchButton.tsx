import { Button } from "@loomcast/ui/components/button";
import { SearchIcon } from "lucide-react";
import { useEffect } from "react";
import { toast } from "sonner";

const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);

function announceSearch() {
  toast("Search is on its way", {
    id: "search-soon",
    description: "Soon you can jump to any project, script or setting from here.",
  });
}

/**
 * Placeholder for the command palette. ⌘K (Ctrl K elsewhere) is claimed now so
 * the shortcut never does something else first. Nothing animates on the key.
 */
export function SearchButton() {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey) && !event.altKey) {
        event.preventDefault();
        announceSearch();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={announceSearch}
      aria-keyshortcuts={IS_MAC ? "Meta+K" : "Control+K"}
      className="justify-start gap-2 pr-1.5 font-normal text-muted-foreground max-md:size-6.5 max-md:justify-center max-md:p-0 md:w-[200px]"
    >
      <SearchIcon aria-hidden="true" />
      <span className="max-md:sr-only">Search or jump to…</span>
      <kbd className="ml-auto rounded-sm bg-secondary px-[5px] py-px font-mono text-[10.5px] text-muted-foreground shadow-[0_0_0_1px_var(--border)] max-md:hidden">
        {IS_MAC ? "⌘K" : "Ctrl K"}
      </kbd>
    </Button>
  );
}
