import {
  CONTENT_SEARCH_MAX_LENGTH,
  PIPELINE_STATES,
  type PipelineState,
} from "@loomcast/contracts";
import { Button } from "@loomcast/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@loomcast/ui/components/dropdown-menu";
import { Input } from "@loomcast/ui/components/input";
import { type StatusTone, statusStyle } from "@loomcast/ui/components/StatusPill";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@loomcast/ui/components/select";
import { cn } from "@loomcast/ui/lib/cn";
import { ChevronDownIcon, CircleDashedIcon, SearchIcon, XIcon } from "lucide-react";
import { Fragment, useEffect, useRef, useState } from "react";
import { useDebouncedValue } from "@/features/kb/use-debounced-value";
import type { SeriesOption } from "./queries";
import { hasFilters, type LibraryFilter } from "./search";

/** Search waits this long after the last keystroke. */
export const LIBRARY_SEARCH_DEBOUNCE_MS = 200;

const ALL_SERIES = "all";

// Full class names so Tailwind can find them.
const toneDot: Record<StatusTone, string> = {
  gray: "bg-status-gray",
  amber: "bg-status-amber",
  violet: "bg-status-violet",
  blue: "bg-status-blue",
  green: "bg-status-green",
  red: "bg-status-red",
};

export function StateDot({ state, className }: { state: PipelineState; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        toneDot[statusStyle("pipeline", state).tone],
        className,
      )}
    />
  );
}

export function stateLabel(state: PipelineState): string {
  return statusStyle("pipeline", state).label;
}

export interface LibraryFiltersProps {
  filter: LibraryFilter;
  onChange: (next: LibraryFilter) => void;
  series: SeriesOption[];
}

/**
 * Search, state, series and target-date filters over the library. Everything lives in the
 * address; the search box writes there once typing settles. Channels join the filters once
 * posts can be scheduled.
 */
export function LibraryFilters({ filter, onChange, series }: LibraryFiltersProps) {
  const [input, setInput] = useState(filter.q);
  const q = useDebouncedValue(input.trim(), LIBRARY_SEARCH_DEBOUNCE_MS);

  const latest = useRef({ filter, onChange });
  latest.current = { filter, onChange };

  // The settled query goes into the address.
  useEffect(() => {
    const { filter: current, onChange: change } = latest.current;
    if (q !== current.q) change({ ...current, q });
  }, [q]);

  // The address changed by itself (Back, a link): show its query.
  const settled = useRef(q);
  settled.current = q;
  useEffect(() => {
    if (filter.q !== settled.current) setInput(filter.q);
  }, [filter.q]);

  const clearAll = () => {
    setInput("");
    onChange({ ...filter, states: [], seriesId: null, from: null, to: null, q: "" });
  };

  return (
    <search
      aria-label="Filter the library"
      className="flex flex-wrap items-center gap-2 border-divider border-b px-3 py-2.5"
    >
      <div className="relative w-full sm:w-56">
        <SearchIcon
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          type="search"
          aria-label="Search titles and pitches"
          placeholder="Search titles and pitches"
          value={input}
          maxLength={CONTENT_SEARCH_MAX_LENGTH}
          className="pl-8"
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && input) {
              event.preventDefault();
              setInput("");
              onChange({ ...filter, q: "" });
            }
          }}
        />
      </div>

      <StateFilter
        selected={filter.states}
        onChange={(states) => onChange({ ...filter, states })}
      />

      <SeriesFilter
        options={series}
        selected={filter.seriesId}
        onChange={(seriesId) => onChange({ ...filter, seriesId })}
      />

      <fieldset className="flex items-center gap-1.5">
        <legend className="sr-only">Target date</legend>
        <span aria-hidden="true" className="text-small text-muted-foreground">
          Target
        </span>
        <Input
          type="date"
          aria-label="Target from"
          value={filter.from ?? ""}
          max={filter.to ?? undefined}
          className="h-8 w-[136px] tabular-nums"
          onChange={(event) => onChange({ ...filter, from: event.target.value || null })}
        />
        <span aria-hidden="true" className="text-text-4">
          –
        </span>
        <Input
          type="date"
          aria-label="Target to"
          value={filter.to ?? ""}
          min={filter.from ?? undefined}
          className="h-8 w-[136px] tabular-nums"
          onChange={(event) => onChange({ ...filter, to: event.target.value || null })}
        />
      </fieldset>

      {hasFilters(filter) ? (
        <Button variant="ghost" size="sm" onClick={clearAll} className="ml-auto">
          <XIcon aria-hidden="true" />
          Clear filters
        </Button>
      ) : null}
    </search>
  );
}

function StateFilter({
  selected,
  onChange,
}: {
  selected: PipelineState[];
  onChange: (states: PipelineState[]) => void;
}) {
  const toggle = (state: PipelineState, checked: boolean) => {
    const next = new Set(selected);
    if (checked) next.add(state);
    else next.delete(state);
    onChange(PIPELINE_STATES.filter((value) => next.has(value)));
  };
  const [first] = selected;
  const summary =
    selected.length === 0
      ? "Any state"
      : selected.length === 1 && first
        ? stateLabel(first)
        : `${selected.length} states`;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          className={cn("h-8", selected.length > 0 && "text-primary")}
          aria-label={`State: ${summary}`}
        >
          {selected.length === 1 && first ? (
            <StateDot state={first} />
          ) : (
            <CircleDashedIcon aria-hidden="true" />
          )}
          {summary}
          <ChevronDownIcon aria-hidden="true" className="text-text-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="min-w-52">
        <DropdownMenuLabel>Pipeline state</DropdownMenuLabel>
        {PIPELINE_STATES.map((state) => (
          <DropdownMenuCheckboxItem
            key={state}
            checked={selected.includes(state)}
            // Stay open so several states can be picked in a row.
            onSelect={(event) => event.preventDefault()}
            onCheckedChange={(checked) => toggle(state, checked === true)}
          >
            <StateDot state={state} />
            {stateLabel(state)}
          </DropdownMenuCheckboxItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={selected.length === 0} onSelect={() => onChange([])}>
          Any state but archived
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SeriesFilter({
  options,
  selected,
  onChange,
}: {
  options: SeriesOption[];
  selected: string | null;
  onChange: (seriesId: string | null) => void;
}) {
  // A series from a link that is not loaded (yet) still shows as chosen.
  const known = selected === null || options.some((option) => option.series.id === selected);
  const groups = new Map<string, SeriesOption[]>();
  for (const option of options) {
    const key = option.workspace?.name ?? "";
    groups.set(key, [...(groups.get(key) ?? []), option]);
  }
  const grouped = groups.size > 1;

  return (
    <Select
      value={selected ?? ALL_SERIES}
      onValueChange={(value) => onChange(value === ALL_SERIES ? null : value)}
      disabled={options.length === 0 && selected === null}
    >
      <SelectTrigger aria-label="Series" className={cn("max-w-56", selected && "text-primary")}>
        <SelectValue placeholder="All series" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL_SERIES}>All series</SelectItem>
        {selected !== null && !known ? (
          <SelectItem value={selected}>Selected series</SelectItem>
        ) : null}
        {[...groups].map(([workspace, entries]) => (
          <Fragment key={workspace}>
            <SelectSeparator />
            <SelectGroup>
              {grouped ? <SelectLabel>{workspace}</SelectLabel> : null}
              {entries.map(({ series }) => (
                <SelectItem key={series.id} value={series.id}>
                  {series.name}
                </SelectItem>
              ))}
            </SelectGroup>
          </Fragment>
        ))}
      </SelectContent>
    </Select>
  );
}
