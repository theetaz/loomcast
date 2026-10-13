import type { CalendarSlot } from "@loomcast/contracts";
import { cn } from "@loomcast/ui/lib/cn";
import { PlusIcon } from "lucide-react";
import { useBoard } from "./board-context";
import { PlatformDot, platformLabel } from "./post-status";
import { longDayLabel } from "./time";

/**
 * A cadence slot no post holds, drawn dashed. Clicking it offers the series' approved videos.
 * Slots too close to now to schedule stay visible but can't be picked.
 */
export function OpenSlot({
  slot,
  day,
  time,
  compact = false,
}: {
  slot: CalendarSlot;
  day: string;
  time: string;
  compact?: boolean;
}) {
  const board = useBoard();
  const channel = board.channels.get(slot.channelId);
  const series = board.series.get(slot.seriesId);
  const tooLate = Date.parse(slot.at) < board.earliestMs;
  const where = channel
    ? `${channel.displayName} (${platformLabel(channel.platform)})`
    : "a channel";

  return (
    <button
      type="button"
      data-open-slot={slot.at}
      disabled={tooLate}
      aria-label={`Open slot, ${longDayLabel(day)} at ${time}: ${series?.name ?? "a series"} on ${where}. Schedule an approved video.`}
      onClick={() => board.onPickSlot(slot)}
      className={cn(
        "flex w-full min-w-0 items-center gap-1.5 rounded-md border border-input border-dashed text-left text-muted-foreground outline-none",
        "transition-[background-color,color,border-color] hover:border-primary/50 hover:bg-accent-soft hover:text-foreground",
        "focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
        compact ? "px-1.5 py-[2px]" : "px-1.5 py-1",
      )}
    >
      {channel ? <PlatformDot platform={channel.platform} /> : null}
      <span
        className={cn("shrink-0 font-mono text-[11px] tabular-nums", compact && "max-sm:hidden")}
      >
        {time}
      </span>
      <span className="min-w-0 flex-1 truncate text-[11.5px]">{series?.name ?? "Open slot"}</span>
      <PlusIcon aria-hidden="true" className="size-3 shrink-0" />
    </button>
  );
}
