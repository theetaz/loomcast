import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@loomcast/ui/components/command";
import { cn } from "@loomcast/ui/lib/cn";
import { useNavigate } from "@tanstack/react-router";
import { HistoryIcon } from "lucide-react";
import { useState } from "react";
import { useMe } from "@/features/auth/queries";
import { useOptionalCurrentWorkspace } from "@/features/workspace/current";
import { type RecentEntry, useRecent } from "./recent";
import { paletteSources } from "./registry";
import type { PaletteContext, PaletteItem, PaletteSource, PaletteSourceResult } from "./types";

export interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Opens the new workspace dialog; the palette has closed by then. */
  onNewWorkspace: () => void;
}

/**
 * ⌘K: jump to a workspace, a knowledge-base entry or a page, or run an action.
 * It opens and closes instantly; nothing in it animates except the search spinner.
 * Sources live in `./sources`; each filters its own rows.
 */
export function CommandPalette({ open, onOpenChange, onNewWorkspace }: CommandPaletteProps) {
  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Search or jump to"
      description="Find workspaces, knowledge-base entries, pages and actions."
      commandProps={{ shouldFilter: false, loop: true, label: "Search or jump to" }}
    >
      <PaletteBody
        close={() => onOpenChange(false)}
        openNewWorkspace={() => {
          onOpenChange(false);
          onNewWorkspace();
        }}
      />
    </CommandDialog>
  );
}

function PaletteBody({
  close,
  openNewWorkspace,
}: {
  close: () => void;
  openNewWorkspace: () => void;
}) {
  const me = useMe();
  const navigate = useNavigate();
  const workspace = useOptionalCurrentWorkspace();
  const [input, setInput] = useState("");
  const recent = useRecent(me.id);

  const context: PaletteContext = {
    query: input.trim(),
    me,
    workspace,
    openNewWorkspace,
  };

  const open = (href: string) => {
    close();
    void navigate({ href });
  };

  const select = (item: PaletteItem, source: PaletteSource) => {
    if (item.disabled) return;
    if (item.run) {
      close();
      item.run();
      return;
    }
    if (!item.href) return;
    recent.record({
      id: item.id,
      source: source.id,
      label: item.label,
      href: item.href,
      detail: item.recentDetail,
    });
    open(item.href);
  };

  const selectRecent = (entry: RecentEntry) => {
    recent.record(entry);
    open(entry.href);
  };

  return (
    <>
      <CommandInput
        value={input}
        onValueChange={setInput}
        placeholder="Search workspaces, knowledge and pages…"
        aria-label="Search or jump to"
      />
      <CommandList>
        <CommandEmpty>
          No results for “<span className="text-foreground">{context.query}</span>”
        </CommandEmpty>
        {context.query === "" && recent.entries.length > 0 ? (
          <CommandGroup heading="Recent">
            {recent.entries.map((entry) => (
              <PaletteRow
                key={entry.id}
                value={`recent:${entry.id}`}
                item={{
                  id: entry.id,
                  label: entry.label,
                  icon: paletteSources.find((s) => s.id === entry.source)?.icon ?? HistoryIcon,
                  meta: entry.detail,
                }}
                onSelect={() => selectRecent(entry)}
              />
            ))}
          </CommandGroup>
        ) : null}
        {paletteSources.map((source) => (
          <SourceGroup key={source.id} source={source} context={context} onSelect={select} />
        ))}
      </CommandList>
      <div
        aria-hidden="true"
        className="flex h-9 shrink-0 items-center gap-4 border-divider border-t px-3.5 text-[11.5px] text-text-4 pointer-coarse:hidden"
      >
        <span>
          <Kbd>↑</Kbd> <Kbd>↓</Kbd> to move
        </span>
        <span>
          <Kbd>↵</Kbd> to open
        </span>
        <span>
          <Kbd>esc</Kbd> to close
        </span>
      </div>
    </>
  );
}

function Kbd({ children }: { children: string }) {
  return (
    <kbd className="rounded-sm bg-secondary px-[5px] py-px font-mono text-[10.5px] text-muted-foreground shadow-[0_0_0_1px_var(--border)]">
      {children}
    </kbd>
  );
}

function normalizeResult(result: PaletteItem[] | PaletteSourceResult): PaletteSourceResult {
  return Array.isArray(result) ? { items: result } : result;
}

function SourceGroup({
  source,
  context,
  onSelect,
}: {
  source: PaletteSource;
  context: PaletteContext;
  onSelect: (item: PaletteItem, source: PaletteSource) => void;
}) {
  const { items, status } = normalizeResult(source.useItems(context));
  if (items.length === 0) return null;
  return (
    <CommandGroup
      heading={
        status ? (
          <span className="flex items-center justify-between gap-2">
            {source.heading}
            <span className="font-normal">{status}</span>
          </span>
        ) : (
          source.heading
        )
      }
    >
      {items.map((item) => (
        <PaletteRow
          key={item.id}
          value={item.id}
          item={item}
          onSelect={() => onSelect(item, source)}
        />
      ))}
    </CommandGroup>
  );
}

function PaletteRow({
  value,
  item,
  onSelect,
}: {
  value: string;
  item: PaletteItem;
  onSelect: () => void;
}) {
  const Icon = item.icon;
  return (
    <CommandItem value={value} disabled={item.disabled} onSelect={onSelect}>
      <Icon aria-hidden="true" className={cn(item.iconClassName)} />
      <span className="grid min-w-0 flex-1">
        <span className="truncate">{item.label}</span>
        {item.secondary ? (
          <span className="truncate text-small text-muted-foreground">{item.secondary}</span>
        ) : null}
      </span>
      {item.meta ? (
        <span className="max-w-[40%] shrink-0 truncate text-small text-text-4 max-sm:hidden">
          {item.meta}
        </span>
      ) : null}
    </CommandItem>
  );
}
