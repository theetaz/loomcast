import {
  type CalendarSlot,
  MIN_SCHEDULE_LEAD_MS,
  type ScheduledPost,
  type Workspace,
} from "@loomcast/contracts";
import { Button } from "@loomcast/ui/components/button";
import { Tabs, TabsContent } from "@loomcast/ui/components/tabs";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ImagePlusIcon, InfoIcon } from "lucide-react";
import { type ReactNode, useCallback, useMemo, useRef, useState } from "react";
import { ErrorState } from "@/components/ErrorState";
import { Page, PageHeader } from "@/components/PageHeader";
import { channelsQueryOptions } from "@/features/channels/queries";
import { NewPostDialog } from "@/features/composer/NewPostDialog";
import { type SeriesOption, useSeriesOptions } from "@/features/library/queries";
import { useNow } from "@/lib/use-now";
import { useTitle } from "@/lib/use-title";
import { CalendarBoard } from "./CalendarBoard";
import { CalendarFilters, CalendarToolbar } from "./CalendarToolbar";
import { isVisiblePost } from "./model";
import { calendarQueryKey, calendarQueryOptions, useFormatZones } from "./queries";
import { SlotPicker } from "./SlotPicker";
import { type CalendarSearch, type CalendarView, parseIds } from "./search";
import { browserTimeZone, calendarPeriod, periodLabel, shiftAnchor, todayIn } from "./time";
import { useCalendarLive } from "./use-calendar-live";
import { useCalendarShortcuts } from "./use-calendar-shortcuts";

/**
 * The time zone of the series the calendar shows: the filtered ones, or every active series. Null
 * when they don't share one (or their formats haven't loaded).
 */
export function seriesTimeZone(
  seriesIds: readonly string[],
  options: readonly SeriesOption[],
  formatZones: ReadonlyMap<string, string>,
): string | null {
  const candidates =
    seriesIds.length > 0
      ? options.filter((option) => seriesIds.includes(option.series.id))
      : options.filter((option) => option.series.status !== "archived");
  const zones = new Set<string>();
  for (const option of candidates) {
    const zone = formatZones.get(option.series.formatId);
    if (zone) zones.add(zone);
  }
  return zones.size === 1 ? ([...zones][0] ?? null) : null;
}

/** Drops empty values so plain links stay plain. */
function clean(search: CalendarSearch): CalendarSearch {
  return Object.fromEntries(
    Object.entries(search).filter(([, value]) => value !== undefined && value !== ""),
  ) as CalendarSearch;
}

export interface CalendarPageProps {
  workspace: Workspace;
  search: CalendarSearch;
  onSearchChange: (update: (previous: CalendarSearch) => CalendarSearch) => void;
}

/**
 * Every post on the workspace's channels in a week or month. Posts that haven't started publishing
 * can be dragged (or moved with the keyboard) to a new time; open cadence slots take an approved
 * video. Times follow the workspace's time zone unless another is picked.
 */
export function CalendarPage({ workspace, search, onSearchChange }: CalendarPageProps) {
  useTitle(`Calendar · ${workspace.name}`);
  useCalendarLive();
  const navigate = useNavigate();
  const now = useNow();

  const view: CalendarView = search.view ?? "week";
  const channelIds = useMemo(() => parseIds(search.channels), [search.channels]);
  const seriesIds = useMemo(() => parseIds(search.series), [search.series]);

  const { options: seriesOptions, byId: seriesById } = useSeriesOptions(workspace.id);
  const workspaceIds = useMemo(() => [workspace.id], [workspace.id]);
  const formatZones = useFormatZones(workspaceIds);
  const localZone = useMemo(browserTimeZone, []);
  const seriesZone = seriesTimeZone(seriesIds, seriesOptions, formatZones);
  const zoneMode = search.zone ?? "workspace";
  const zone =
    zoneMode === "series" && seriesZone
      ? seriesZone
      : zoneMode === "local"
        ? localZone
        : workspace.timeZone;

  const today = todayIn(zone, now);
  const anchor = search.date ?? today;
  const period = useMemo(() => calendarPeriod(view, anchor, zone), [view, anchor, zone]);
  const key = calendarQueryKey(period.from, period.to, channelIds, seriesIds, workspace.id);
  const calendar = useQuery({ ...calendarQueryOptions(key), placeholderData: keepPreviousData });
  const channels = useQuery(channelsQueryOptions(workspace.id));
  const channelList = channels.data?.items ?? [];
  const channelsById = useMemo(
    () => new Map((channels.data?.items ?? []).map((channel) => [channel.id, channel])),
    [channels.data],
  );

  const update = useCallback(
    (change: Partial<CalendarSearch>) =>
      onSearchChange((previous) => clean({ ...previous, ...change })),
    [onSearchChange],
  );
  const goTo = useCallback(
    (delta: number) => update({ date: shiftAnchor(view, anchor, delta) }),
    [update, view, anchor],
  );
  const goToday = useCallback(() => update({ date: undefined }), [update]);

  const draggingRef = useRef(false);
  const onDraggingChange = useCallback((dragging: boolean) => {
    draggingRef.current = dragging;
  }, []);
  useCalendarShortcuts(
    { onPrevious: () => goTo(-1), onNext: () => goTo(1), onToday: goToday },
    draggingRef,
  );

  const [slot, setSlot] = useState<CalendarSlot | null>(null);
  const onOpenPost = useCallback(
    (post: ScheduledPost) =>
      void navigate({
        to: "/w/$workspace/content/$itemId",
        params: { workspace: workspace.slug, itemId: post.itemId },
      }),
    [navigate, workspace.slug],
  );
  const onShowDay = useCallback((day: string) => update({ view: undefined, date: day }), [update]);

  const data = calendar.data;
  const empty =
    data !== undefined &&
    !calendar.isPlaceholderData &&
    !data.posts.some(isVisiblePost) &&
    !data.slots.some((entry) => !entry.postId);

  return (
    <Page className="max-w-[1320px]">
      <PageHeader
        title="Calendar"
        description="Every post on this workspace's channels. Drag a post to move it, or fill an open slot."
        actions={
          <NewPostDialog workspaceId={workspace.id}>
            <Button>
              <ImagePlusIcon aria-hidden="true" />
              New post
            </Button>
          </NewPostDialog>
        }
      />
      <Tabs
        value={view}
        onValueChange={(next) => update({ view: next === "month" ? "month" : undefined })}
        className="gap-0 overflow-hidden rounded-lg bg-card shadow-card"
      >
        <CalendarToolbar
          view={view}
          label={periodLabel(period)}
          showsToday={
            view === "week" ? period.days.includes(today) : period.month === today.slice(0, 7)
          }
          onPrevious={() => goTo(-1)}
          onNext={() => goTo(1)}
          onToday={goToday}
        />
        <CalendarFilters
          channels={channelList}
          channelIds={channelIds}
          onChannelsChange={(ids) => update({ channels: ids.join(",") || undefined })}
          series={seriesOptions}
          seriesIds={seriesIds}
          onSeriesChange={(ids) => update({ series: ids.join(",") || undefined })}
          zoneMode={zoneMode}
          workspaceZone={workspace.timeZone}
          localZone={localZone}
          seriesZone={seriesZone}
          onZoneChange={(mode) => update({ zone: mode === "workspace" ? undefined : mode })}
          onClear={() => update({ channels: undefined, series: undefined })}
        />
        {channels.isSuccess && channelList.length === 0 ? (
          <Notice>
            This workspace has no channels yet. Posts and cadence slots appear here once a series is
            linked to a channel.
          </Notice>
        ) : empty ? (
          <Notice>
            Nothing is planned for this {view}. Series with a cadence and linked channels add their
            slots here as they are planned.
          </Notice>
        ) : null}
        <TabsContent value={view} tabIndex={-1} aria-busy={calendar.isPending || undefined}>
          {calendar.isError && !data ? (
            <ErrorState
              title="Couldn't load the calendar"
              error={calendar.error}
              onRetry={() => void calendar.refetch()}
              retrying={calendar.isRefetching}
            />
          ) : (
            <CalendarBoard
              period={period}
              data={data}
              zone={zone}
              now={now}
              today={today}
              earliestMs={now + MIN_SCHEDULE_LEAD_MS}
              channels={channelsById}
              series={seriesById}
              onOpenPost={onOpenPost}
              onPickSlot={setSlot}
              onShowDay={onShowDay}
              onDraggingChange={onDraggingChange}
            />
          )}
        </TabsContent>
      </Tabs>
      <SlotPicker
        slot={slot}
        zone={zone}
        channel={slot ? channelsById.get(slot.channelId) : undefined}
        series={slot ? seriesById.get(slot.seriesId) : undefined}
        onClose={() => setSlot(null)}
      />
    </Page>
  );
}

function Notice({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-start gap-2 border-divider border-b bg-secondary/40 px-3 py-2 text-control text-muted-foreground">
      <InfoIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
      <span>{children}</span>
    </p>
  );
}
