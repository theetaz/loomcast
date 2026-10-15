import {
  type CalendarSlot,
  type Channel,
  OPEN_POST_STATUSES,
  type Series,
} from "@loomcast/contracts";
import { Button } from "@loomcast/ui/components/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@loomcast/ui/components/dialog";
import { ScrollArea } from "@loomcast/ui/components/scroll-area";
import { Skeleton } from "@loomcast/ui/components/skeleton";
import { cn } from "@loomcast/ui/lib/cn";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckIcon, FilmIcon } from "lucide-react";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { platformLabel } from "@/features/channels/platforms";
import { errorMessage, isApiError } from "@/lib/api";
import { approvedItemsQueryOptions, cachedPosts, useCreatePost } from "./queries";
import { longDayLabel, placeInstant } from "./time";

export interface SlotPickerProps {
  slot: CalendarSlot | null;
  zone: string;
  channel: Channel | undefined;
  series: Series | undefined;
  onClose: () => void;
}

/** Fills an open cadence slot with one of the series' approved videos. */
export function SlotPicker({ slot, zone, channel, series, onClose }: SlotPickerProps) {
  return (
    <Dialog open={slot !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="sm:max-w-[460px]">
        {slot ? (
          <SlotPickerForm
            key={`${slot.seriesId}:${slot.channelId}:${slot.at}`}
            slot={slot}
            zone={zone}
            channel={channel}
            series={series}
            onDone={onClose}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function SlotPickerForm({
  slot,
  zone,
  channel,
  series,
  onDone,
}: {
  slot: CalendarSlot;
  zone: string;
  channel: Channel | undefined;
  series: Series | undefined;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const items = useQuery(approvedItemsQueryOptions(slot.seriesId));
  const create = useCreatePost();
  const [itemId, setItemId] = useState<string | null>(null);
  const place = placeInstant(slot.at, zone);
  const when = `${longDayLabel(place.day)}, ${place.time}`;
  const where = channel
    ? `${channel.displayName} (${platformLabel(channel.platform)})`
    : "this channel";

  // An item has one open post per channel: leave out those already planned or queued here.
  const taken = new Set(
    cachedPosts(queryClient)
      .filter(
        (post) =>
          post.channelId === slot.channelId &&
          (OPEN_POST_STATUSES as readonly string[]).includes(post.status),
      )
      .map((post) => post.itemId),
  );
  const choices = (items.data?.items ?? []).filter((item) => !taken.has(item.id));
  const chosen = choices.find((item) => item.id === itemId) ?? null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!chosen) return;
    create.mutate(
      { itemId: chosen.id, channelId: slot.channelId, scheduledAt: slot.at },
      {
        onSuccess: () => {
          toast.success(`Scheduled “${chosen.title}”`, { description: `${where}, ${when}.` });
          onDone();
        },
      },
    );
  };

  const failure = create.error
    ? isApiError(create.error, 409)
      ? "That video already has a post on this channel, or the slot was taken. Pick another."
      : errorMessage(create.error)
    : null;

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>Fill this slot</DialogTitle>
        <DialogDescription>
          {series?.name ?? "This series"} on {where}, {when}.
        </DialogDescription>
      </DialogHeader>

      {items.isPending ? (
        <div className="flex flex-col gap-1.5" aria-hidden="true">
          <Skeleton className="h-9" />
          <Skeleton className="h-9" />
        </div>
      ) : items.isError ? (
        <ErrorState
          size="compact"
          title="Couldn't load the approved videos"
          error={items.error}
          onRetry={() => void items.refetch()}
          retrying={items.isRefetching}
        />
      ) : choices.length === 0 ? (
        <EmptyState
          size="compact"
          icon={FilmIcon}
          title="No approved videos to schedule"
          description={`Approve a video of ${series?.name ?? "this series"} in review, then come back to this slot.`}
        />
      ) : (
        <ScrollArea viewportClassName="max-h-72">
          <fieldset className="flex flex-col gap-1">
            <legend className="sr-only">Approved videos</legend>
            {choices.map((item) => {
              const selected = item.id === itemId;
              return (
                <label
                  key={item.id}
                  className={cn(
                    "flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-control transition-colors",
                    "has-focus-visible:ring-2 has-focus-visible:ring-ring",
                    selected ? "bg-accent-soft text-foreground" : "hover:bg-secondary",
                  )}
                >
                  <input
                    type="radio"
                    name="item"
                    value={item.id}
                    checked={selected}
                    onChange={() => setItemId(item.id)}
                    className="sr-only"
                  />
                  <span
                    aria-hidden="true"
                    className={cn(
                      "flex size-4 shrink-0 items-center justify-center rounded-full border",
                      selected
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-input",
                    )}
                  >
                    {selected ? <CheckIcon className="size-3" /> : null}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{item.title}</span>
                  <span className="shrink-0 text-small text-muted-foreground">
                    v{item.versionNo}
                  </span>
                </label>
              );
            })}
          </fieldset>
        </ScrollArea>
      )}

      {failure ? (
        <p role="alert" className="text-control text-destructive">
          {failure}
        </p>
      ) : null}

      <DialogFooter>
        <DialogClose asChild>
          <Button type="button" variant="outline">
            Cancel
          </Button>
        </DialogClose>
        <Button type="submit" disabled={!chosen || create.isPending}>
          {create.isPending ? "Scheduling…" : "Schedule"}
        </Button>
      </DialogFooter>
    </form>
  );
}
