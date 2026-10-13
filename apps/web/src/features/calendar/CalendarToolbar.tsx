import type { Channel } from "@loomcast/contracts";
import { Button } from "@loomcast/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@loomcast/ui/components/dropdown-menu";
import { TabsList, TabsTrigger } from "@loomcast/ui/components/tabs";
import { cn } from "@loomcast/ui/lib/cn";
import {
  CalendarDaysIcon,
  CalendarRangeIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  GlobeIcon,
  LayersIcon,
  RadioTowerIcon,
  XIcon,
} from "lucide-react";
import { Fragment } from "react";
import { PlatformDot, platformLabel } from "@/features/channels/platforms";
import type { SeriesOption } from "@/features/library/queries";
import type { CalendarView, CalendarZoneMode } from "./search";

export interface CalendarToolbarProps {
  view: CalendarView;
  label: string;
  /** Whether the period shown contains today. */
  showsToday: boolean;
  onPrevious: () => void;
  onNext: () => void;
  onToday: () => void;
}

/** Today, previous and next, the period and the week or month switch. */
export function CalendarToolbar({
  view,
  label,
  showsToday,
  onPrevious,
  onNext,
  onToday,
}: CalendarToolbarProps) {
  const unit = view === "week" ? "week" : "month";
  return (
    <div className="flex flex-wrap items-center gap-2 border-divider border-b px-3 py-2.5">
      <Button
        variant="outline"
        size="sm"
        onClick={onToday}
        disabled={showsToday}
        aria-keyshortcuts="T"
      >
        Today
      </Button>
      <div className="flex items-center">
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onPrevious}
          aria-label={`Previous ${unit}`}
          aria-keyshortcuts="ArrowLeft"
        >
          <ChevronLeftIcon aria-hidden="true" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onNext}
          aria-label={`Next ${unit}`}
          aria-keyshortcuts="ArrowRight"
        >
          <ChevronRightIcon aria-hidden="true" />
        </Button>
      </div>
      <h2 aria-live="polite" className="min-w-0 truncate text-heading text-foreground">
        {label}
      </h2>
      <TabsList aria-label="View" className="ml-auto">
        <TabsTrigger value="week" className="flex-none">
          <CalendarRangeIcon aria-hidden="true" />
          Week
        </TabsTrigger>
        <TabsTrigger value="month" className="flex-none">
          <CalendarDaysIcon aria-hidden="true" />
          Month
        </TabsTrigger>
      </TabsList>
    </div>
  );
}

export interface CalendarFiltersProps {
  channels: Channel[];
  channelIds: string[];
  onChannelsChange: (ids: string[]) => void;
  series: SeriesOption[];
  seriesIds: string[];
  onSeriesChange: (ids: string[]) => void;
  zoneMode: CalendarZoneMode;
  localZone: string;
  /** The filtered series' time zone; null when they don't share one. */
  seriesZone: string | null;
  onZoneChange: (mode: CalendarZoneMode) => void;
  onClear: () => void;
}

function toggle(ids: readonly string[], id: string, on: boolean): string[] {
  const next = ids.filter((entry) => entry !== id);
  return on ? [...next, id] : next;
}

/** Channel and series filters, and the clock the grid follows. */
export function CalendarFilters({
  channels,
  channelIds,
  onChannelsChange,
  series,
  seriesIds,
  onSeriesChange,
  zoneMode,
  localZone,
  seriesZone,
  onZoneChange,
  onClear,
}: CalendarFiltersProps) {
  const [firstChannel] = channelIds;
  const channelSummary =
    channelIds.length === 0
      ? "All channels"
      : channelIds.length === 1 && firstChannel
        ? (channels.find((channel) => channel.id === firstChannel)?.displayName ?? "1 channel")
        : `${channelIds.length} channels`;

  const [firstSeries] = seriesIds;
  const seriesSummary =
    seriesIds.length === 0
      ? "All series"
      : seriesIds.length === 1 && firstSeries
        ? (series.find((option) => option.series.id === firstSeries)?.series.name ?? "1 series")
        : `${seriesIds.length} series`;

  const groups = new Map<string, SeriesOption[]>();
  for (const option of series) {
    const key = option.project?.name ?? "";
    groups.set(key, [...(groups.get(key) ?? []), option]);
  }

  const usesSeriesZone = zoneMode === "series" && seriesZone !== null;
  const zone = usesSeriesZone ? seriesZone : localZone;

  return (
    <search
      aria-label="Filter the calendar"
      className="flex flex-wrap items-center gap-2 border-divider border-b px-3 py-2"
    >
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            className={cn("h-8 max-w-60", channelIds.length > 0 && "text-primary")}
            aria-label={`Channels: ${channelSummary}`}
          >
            <RadioTowerIcon aria-hidden="true" />
            <span className="truncate">{channelSummary}</span>
            <ChevronDownIcon aria-hidden="true" className="text-text-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-60">
          <DropdownMenuLabel>Channels</DropdownMenuLabel>
          {channels.length === 0 ? (
            <DropdownMenuItem disabled>No channels yet</DropdownMenuItem>
          ) : null}
          {channels.map((channel) => (
            <DropdownMenuCheckboxItem
              key={channel.id}
              checked={channelIds.includes(channel.id)}
              onSelect={(event) => event.preventDefault()}
              onCheckedChange={(checked) =>
                onChannelsChange(toggle(channelIds, channel.id, checked === true))
              }
            >
              <PlatformDot platform={channel.platform} />
              <span className="min-w-0 truncate">{channel.displayName}</span>
              <span className="ml-auto pl-3 text-small text-muted-foreground">
                {platformLabel(channel.platform)}
              </span>
            </DropdownMenuCheckboxItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={channelIds.length === 0}
            onSelect={() => onChannelsChange([])}
          >
            All channels
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            className={cn("h-8 max-w-60", seriesIds.length > 0 && "text-primary")}
            aria-label={`Series: ${seriesSummary}`}
          >
            <LayersIcon aria-hidden="true" />
            <span className="truncate">{seriesSummary}</span>
            <ChevronDownIcon aria-hidden="true" className="text-text-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-60">
          {series.length === 0 ? <DropdownMenuItem disabled>No series yet</DropdownMenuItem> : null}
          {[...groups].map(([project, options], index) => (
            <Fragment key={project}>
              {index > 0 ? <DropdownMenuSeparator /> : null}
              <DropdownMenuGroup>
                <DropdownMenuLabel>{project || "Series"}</DropdownMenuLabel>
                {options.map(({ series: entry }) => (
                  <DropdownMenuCheckboxItem
                    key={entry.id}
                    checked={seriesIds.includes(entry.id)}
                    onSelect={(event) => event.preventDefault()}
                    onCheckedChange={(checked) =>
                      onSeriesChange(toggle(seriesIds, entry.id, checked === true))
                    }
                  >
                    <span className="min-w-0 truncate">{entry.name}</span>
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuGroup>
            </Fragment>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={seriesIds.length === 0} onSelect={() => onSeriesChange([])}>
            All series
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" className="h-8 max-w-72" aria-label={`Time zone: ${zone}`}>
            <GlobeIcon aria-hidden="true" />
            <span className="truncate">
              {usesSeriesZone ? "Series time" : "Your time"}
              <span className="text-muted-foreground"> · {zone.replaceAll("_", " ")}</span>
            </span>
            <ChevronDownIcon aria-hidden="true" className="text-text-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-64">
          <DropdownMenuLabel>Show times in</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={usesSeriesZone ? "series" : "local"}
            onValueChange={(value) => onZoneChange(value === "series" ? "series" : "local")}
          >
            <DropdownMenuRadioItem value="local">
              Your time zone
              <span className="ml-auto pl-3 text-small text-muted-foreground">{localZone}</span>
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="series" disabled={seriesZone === null}>
              Series time zone
              <span className="ml-auto pl-3 text-small text-muted-foreground">
                {seriesZone ?? "Pick one series"}
              </span>
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      {channelIds.length > 0 || seriesIds.length > 0 ? (
        <Button variant="ghost" size="sm" className="ml-auto" onClick={onClear}>
          <XIcon aria-hidden="true" />
          Clear filters
        </Button>
      ) : null}
    </search>
  );
}
