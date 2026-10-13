import type { CalendarSlot } from "@loomcast/contracts";
import { cn } from "@loomcast/ui/lib/cn";
import { useBoard } from "./board-context";
import { PlatformDot, platformLabel } from "./post-status";
import { longDayLabel } from "./time";

/** A cadence slot no post holds, drawn dashed. */
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
  const where = channel
    ? `${channel.displayName} (${platformLabel(channel.platform)})`
    : "a channel";

  return (
    <div
      role="note"
      data-open-slot={slot.at}
      aria-label={`Open slot, ${longDayLabel(day)} at ${time}: ${series?.name ?? "a series"} on ${where}.`}
      className={cn(
        "flex w-full min-w-0 items-center gap-1.5 rounded-md border border-input border-dashed text-muted-foreground",
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
    </div>
  );
}
