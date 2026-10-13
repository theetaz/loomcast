import type { Channel, ScheduledPost } from "@loomcast/contracts";
import { cn } from "@loomcast/ui/lib/cn";
import type { ComponentProps } from "react";
import { useBoard } from "./board-context";
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

/** A post on the board. Clicking it, or Enter, opens its video. */
export function PostChip({ post, day, time, compact }: PostChipProps) {
  const board = useBoard();
  return (
    <ChipButton
      post={post}
      day={day}
      time={time}
      compact={compact}
      channel={board.channels.get(post.channelId)}
      onClick={() => board.onOpenPost(post)}
    />
  );
}

interface ChipButtonProps extends Omit<ComponentProps<"button">, "children"> {
  post: ScheduledPost;
  day: string;
  time: string;
  channel: Channel | undefined;
  compact?: boolean;
}

function ChipButton({
  post,
  day,
  time,
  channel,
  compact = false,
  className,
  ...props
}: ChipButtonProps) {
  return (
    <button
      type="button"
      data-post-chip={post.id}
      data-status={post.status}
      aria-label={postSummary(post, `${longDayLabel(day)}, ${time}`, channel)}
      className={cn(
        "relative flex w-full min-w-0 select-none rounded-md bg-card text-left shadow-card outline-none",
        "transition-[background-color,opacity] focus-visible:ring-2 focus-visible:ring-ring",
        "hover:bg-secondary",
        "cursor-pointer",
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
