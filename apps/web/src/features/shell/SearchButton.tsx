import { Button } from "@loomcast/ui/components/button";
import { SearchIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { preloadPalette, usePaletteModule, whenIdle } from "@/features/palette/load";
import { IS_MAC, usePaletteShortcut } from "@/features/palette/use-palette-shortcut";
import { NewWorkspaceDialog } from "@/features/workspaces/NewWorkspaceDialog";

/** Starts loading the palette chunk; a failure is retried on the next attempt. */
function warmPalette() {
  void preloadPalette().catch(() => {});
}

/**
 * Opens the command palette, as do ⌘K (Ctrl K elsewhere) anywhere in the app.
 * The shortcut toggles it. Nothing animates on the key or the click.
 *
 * The open state and the shortcut live here, in the main chunk; the palette
 * itself is a separate chunk, loaded on idle or when the pointer or focus
 * reaches this button. Asked to open before the chunk is there, the palette
 * appears as soon as it arrives, without a spinner.
 */
export function SearchButton() {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [newWorkspaceOpen, setNewWorkspaceOpen] = useState(false);
  const palette = usePaletteModule();

  useEffect(() => whenIdle(warmPalette), []);

  const request = (open: boolean) => {
    setPaletteOpen(open);
    if (!open) return;
    preloadPalette().catch(() => {
      setPaletteOpen(false);
      toast.error("Couldn't open search", {
        id: "palette-load-failed",
        description: "Check your connection, then try again.",
      });
    });
  };

  usePaletteShortcut(() => request(!paletteOpen));

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => request(true)}
        onPointerEnter={warmPalette}
        onFocus={warmPalette}
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
      {palette ? (
        <palette.CommandPalette
          open={paletteOpen}
          onOpenChange={setPaletteOpen}
          onNewWorkspace={() => setNewWorkspaceOpen(true)}
        />
      ) : null}
      <NewWorkspaceDialog open={newWorkspaceOpen} onOpenChange={setNewWorkspaceOpen} />
    </>
  );
}
