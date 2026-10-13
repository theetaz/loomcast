import { useDraggable } from "@dnd-kit/core";
import type { Channel, ScheduledPost } from "@loomcast/contracts";
import { cn } from "@loomcast/ui/lib/cn";
import type { ComponentProps, KeyboardEvent, MouseEvent, Ref } from "react";
import { useBoard } from "./board-context";
import { isReschedulable } from "./model";
import {
  PlatformDot,
  PostStatusDot,
  PostStatusPill,
  platformLabel,
  postStatusStyle,
} from "./post-status";
import { longDayLabel } from "./time";

/** What a screen reader hears for a chip: title, channel, day and time, and state. */
export function postSummary(post: ScheduledPost, when: string, channel: Channel | undefined) {
  const where = channel
    ? `${channel.displayName} (${platformLabel(post.platform)})`
    : platformLabel(post.platform);
  return `${post.item.title}. ${where}, ${when}. ${postStatusStyle(post.status).label}.`;
}

export interface PostChipProps {
  post: ScheduledPost;
  /** The local day and `HH:mm` in the board's zone. */
  day: string;
  time: string;
  /** One line, for month days. */
  compact?: boolean;
}

/**
 * A post on the board. Posts that can move are draggable; the rest (and posts whose move is still
 * saving) only open their video. One element either way, so focus survives the switch.
 */
export function PostChip({ post, day, time, compact }: PostChipProps) {
  const board = useBoard();
  const busy = board.saving.has(post.id);
  const draggable = isReschedulable(post) && !busy;
  const { attributes, listeners, setNodeRef } = useDraggable({
    id: post.id,
    data: { post },
    disabled: !draggable,
  });

  return (
    <ChipButton
      ref={setNodeRef}
      post={post}
      day={day}
      time={time}
      compact={compact}
      channel={board.channels.get(post.channelId)}
      draggable={draggable}
      dimmed={board.drag?.post.id === post.id}
      busy={busy}
      {...(draggable ? { ...attributes, ...listeners } : {})}
      // Keyboard clicks (Space after a drop, Enter) have no detail; Enter opens the video below.
      onClick={(event) => {
        if (event.detail > 0 && !board.drag) board.onOpenPost(post);
      }}
      onKeyDown={(event) => {
        if (draggable) listeners?.onKeyDown?.(event);
        if (event.key === "Enter" && !event.defaultPrevented && !board.drag) {
          event.preventDefault();
          board.onOpenPost(post);
        }
      }}
    />
  );
}

interface ChipButtonProps extends Omit<ComponentProps<"button">, "children"> {
  post: ScheduledPost;
  day: string;
  time: string;
  channel: Channel | undefined;
  compact?: boolean;
  draggable?: boolean;
  /** The original stays in place, faded, while its copy is dragged. */
  dimmed?: boolean;
  busy?: boolean;
  ref?: Ref<HTMLButtonElement>;
  onClick?: (event: MouseEvent<HTMLButtonElement>) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLButtonElement>) => void;
}

function ChipButton({
  post,
  day,
  time,
  channel,
  compact = false,
  draggable = false,
  dimmed = false,
  busy = false,
  className,
  ...props
}: ChipButtonProps) {
  return (
    <button
      type="button"
      data-post-chip={post.id}
      data-status={post.status}
      aria-label={postSummary(post, `${longDayLabel(day)}, ${time}`, channel)}
      aria-busy={busy || undefined}
      className={cn(
        "relative flex w-full min-w-0 select-none rounded-md bg-card text-left shadow-card outline-none",
        "transition-[background-color,opacity] focus-visible:ring-2 focus-visible:ring-ring",
        "hover:bg-secondary",
        draggable ? "cursor-grab touch-manipulation" : "cursor-pointer",
        dimmed && "opacity-40",
        busy && "opacity-70",
        compact ? "items-center gap-1.5 px-1.5 py-[3px]" : "flex-col gap-1 px-1.5 py-1",
        className,
      )}
      {...props}
    >
      <ChipBody post={post} time={time} compact={compact} />
    </button>
  );
}

export function ChipBody({
  post,
  time,
  compact,
}: {
  post: ScheduledPost;
  time: string;
  compact?: boolean;
}) {
  if (compact) {
    return (
      <>
        <PlatformDot platform={post.platform} />
        {/* Phones leave room for the title rather than the time. */}
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums max-sm:hidden">
          {time}
        </span>
        <span className="min-w-0 flex-1 truncate text-[12px] text-foreground">
          {post.item.title}
        </span>
        <PostStatusDot status={post.status} />
      </>
    );
  }
  return (
    <>
      <span className="flex min-w-0 items-center gap-1.5">
        <PlatformDot platform={post.platform} />
        <span className="min-w-0 truncate font-medium text-[12px] text-foreground leading-4">
          {post.item.title}
        </span>
      </span>
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="font-mono text-[11px] text-muted-foreground tabular-nums">{time}</span>
        <PostStatusPill
          status={post.status}
          className="min-w-0 shrink overflow-hidden text-ellipsis"
        />
      </span>
    </>
  );
}

/**
 * The copy that follows the pointer. It lifts (scale 1.02 and a deeper shadow over 160 ms) when the
 * drag starts; under reduced motion only the shadow changes.
 */
export function LiftedChip({ post, time, compact }: Omit<PostChipProps, "day">) {
  return (
    <div
      aria-hidden="true"
      data-drag-overlay=""
      className={cn(
        "flex w-full min-w-0 cursor-grabbing select-none rounded-md bg-card",
        "scale-[1.02] shadow-pop transition-[scale,box-shadow] duration-160 ease-out",
        "starting:scale-100 starting:shadow-card motion-reduce:scale-100",
        compact ? "items-center gap-1.5 px-1.5 py-[3px]" : "flex-col gap-1 px-1.5 py-1",
      )}
    >
      <ChipBody post={post} time={time} compact={compact} />
    </div>
  );
}
