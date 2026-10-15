import { ScrollArea } from "@loomcast/ui/components/scroll-area";
import { cn } from "@loomcast/ui/lib/cn";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import { searchTimeZones, timeZones } from "./cadence";

/** Matches shown at once; typing narrows the rest. */
const MAX_SHOWN = 80;

export interface TimeZoneSelectProps {
  id: string;
  value: string;
  onChange: (zone: string) => void;
  onBlur?: () => void;
  describedBy?: string;
  hasError?: boolean;
  /** The zones to offer; the browser's own list by default. */
  zones?: readonly string[];
}

/**
 * A searchable list of the IANA time zones this browser knows (`Intl.supportedValuesOf`). Typing
 * filters it (`new york`, `london`, `kolkata`); arrows move, Enter picks and Escape restores the
 * saved zone. Only listed zones can be picked, so an offset such as `+05:30` never gets in. It
 * opens without animation, like any field you type in.
 */
export function TimeZoneSelect({
  id,
  value,
  onChange,
  onBlur,
  describedBy,
  hasError,
  zones,
}: TimeZoneSelectProps) {
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const all = useMemo(() => zones ?? timeZones(), [zones]);
  const matches = useMemo(() => searchTimeZones(query, all), [query, all]);
  const shown = matches.slice(0, MAX_SHOWN);

  const close = () => {
    setOpen(false);
    setQuery("");
  };

  const pick = (zone: string) => {
    onChange(zone);
    close();
  };

  const openList = () => {
    setOpen(true);
    setQuery("");
    setActive(Math.max(0, all.indexOf(value)));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        openList();
        return;
      }
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((index) => Math.min(shown.length - 1, Math.max(0, index + step)));
    } else if (event.key === "Enter") {
      if (!open) return;
      event.preventDefault();
      const zone = shown[active];
      if (zone) pick(zone);
    } else if (event.key === "Escape" && open) {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === "Tab" && open) {
      close();
    }
  };

  const activeId = open && shown[active] ? `${listId}-${active}` : undefined;

  // Keep the active option in view as the arrows move through the list.
  useEffect(() => {
    if (activeId) document.getElementById(activeId)?.scrollIntoView({ block: "nearest" });
  }, [activeId]);

  return (
    <div className="relative">
      <div
        className={cn(
          "flex h-8 items-center rounded-md bg-card shadow-card transition-shadow focus-within:shadow-focus",
          hasError && "shadow-[0_0_0_1px_var(--destructive)]",
        )}
      >
        <input
          ref={inputRef}
          id={id}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={activeId}
          aria-describedby={describedBy}
          aria-invalid={hasError || undefined}
          autoComplete="off"
          spellCheck={false}
          value={open ? query : value}
          placeholder={open ? value : undefined}
          onFocus={() => {
            if (!open) openList();
          }}
          onClick={() => {
            if (!open) openList();
          }}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
            if (!open) setOpen(true);
          }}
          onKeyDown={onKeyDown}
          onBlur={() => {
            close();
            onBlur?.();
          }}
          className="h-full min-w-0 flex-1 bg-transparent pl-2.5 text-[13px] text-foreground outline-none placeholder:text-text-4"
        />
        <ChevronDownIcon aria-hidden="true" className="mr-2 size-3.5 shrink-0 text-text-4" />
      </div>
      <div
        hidden={!open}
        className="absolute top-full right-0 left-0 z-50 mt-1 overflow-hidden rounded-lg bg-popover shadow-pop"
      >
        {/* Options take the pointer down, so the input keeps focus while one is clicked. */}
        <ScrollArea viewportClassName="max-h-64">
          <div id={listId} role="listbox" aria-label="Time zones" className="p-1">
            {shown.map((zone, index) => (
              // biome-ignore lint/a11y/useKeyWithClickEvents: the combobox input handles the keys (arrows, Enter) for every option.
              <div
                key={zone}
                id={`${listId}-${index}`}
                role="option"
                tabIndex={-1}
                aria-selected={zone === value}
                data-active={index === active || undefined}
                onPointerDown={(event) => event.preventDefault()}
                onPointerMove={() => setActive(index)}
                onClick={() => pick(zone)}
                className="flex h-7 cursor-default items-center gap-2 rounded-[6px] px-2 text-control text-foreground data-active:bg-accent"
              >
                <span className="min-w-0 flex-1 truncate">{zone.replace(/_/g, " ")}</span>
                {zone === value ? (
                  <CheckIcon aria-hidden="true" className="size-3.5 text-primary" />
                ) : null}
              </div>
            ))}
            {shown.length === 0 ? (
              <p className="px-2 py-2 text-small text-muted-foreground">
                No time zone matches “{query}”.
              </p>
            ) : null}
          </div>
        </ScrollArea>
        {matches.length > shown.length ? (
          <p className="border-divider border-t px-3 py-1.5 text-small text-muted-foreground">
            {matches.length - shown.length} more. Keep typing to narrow the list.
          </p>
        ) : null}
      </div>
    </div>
  );
}
