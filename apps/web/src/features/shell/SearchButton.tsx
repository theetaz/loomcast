import { Button } from "@loomcast/ui/components/button";
import { SearchIcon } from "lucide-react";
import { useState } from "react";
import { CommandPalette } from "@/features/palette/CommandPalette";
import { IS_MAC, usePaletteShortcut } from "@/features/palette/use-palette-shortcut";
import { NewProjectDialog } from "@/features/projects/NewProjectDialog";

/**
 * Opens the command palette, as do ⌘K (Ctrl K elsewhere) anywhere in the app.
 * The shortcut toggles it. Nothing animates on the key or the click.
 */
export function SearchButton() {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [newProjectOpen, setNewProjectOpen] = useState(false);

  usePaletteShortcut(() => setPaletteOpen((open) => !open));

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setPaletteOpen(true)}
        aria-keyshortcuts={IS_MAC ? "Meta+K" : "Control+K"}
        aria-haspopup="dialog"
        className="justify-start gap-2 pr-1.5 font-normal text-muted-foreground max-md:size-6.5 max-md:justify-center max-md:p-0 md:w-[200px]"
      >
        <SearchIcon aria-hidden="true" />
        <span className="max-md:sr-only">Search or jump to…</span>
        <kbd className="ml-auto rounded-sm bg-secondary px-[5px] py-px font-mono text-[10.5px] text-muted-foreground shadow-[0_0_0_1px_var(--border)] max-md:hidden">
          {IS_MAC ? "⌘K" : "Ctrl K"}
        </kbd>
      </Button>
      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        onNewProject={() => setNewProjectOpen(true)}
      />
      <NewProjectDialog open={newProjectOpen} onOpenChange={setNewProjectOpen} />
    </>
  );
}
