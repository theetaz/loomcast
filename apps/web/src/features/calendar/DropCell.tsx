import { useDroppable } from "@dnd-kit/core";
import { cn } from "@loomcast/ui/lib/cn";
import type { ReactNode } from "react";
import { useBoard } from "./board-context";
import { type CellTarget, targetId, targetInstant, targetTime } from "./time";

/** What a drop target carries, for the drop handler and the announcements. */
export interface DropData {
  target: CellTarget;
  /** `Tuesday 14 October, 09:30` for a week cell; the day for a month day. */
  label: string;
}

/**
 * A week cell or a month day posts can be dropped on. While a post is over it, the cell shows
 * where the post would land, without animating: the highlight follows every key press.
 */
export function DropCell({
  target,
  label,
  disabled,
  className,
  children,
}: {
  target: CellTarget;
  label: string;
  disabled: boolean;
  className?: string;
  children?: ReactNode;
}) {
  const id = targetId(target);
  const data: DropData = { target, label };
  const { setNodeRef } = useDroppable({ id, disabled, data });
  const { drag, zone, earliestMs } = useBoard();
  const isTarget = drag?.target != null && targetId(drag.target) === id;
  const landing = isTarget && drag ? targetInstant(target, drag.post.scheduledAt, zone) : null;
  const allowed = landing !== null && landing.getTime() >= earliestMs;

  return (
    <div
      ref={setNodeRef}
      data-cell={id}
      data-over={isTarget || undefined}
      className={cn(
        "relative min-w-0",
        disabled && "bg-secondary/45",
        isTarget && (allowed ? "bg-accent-soft" : "bg-destructive/8"),
        className,
      )}
    >
      {children}
      {isTarget && drag ? (
        <div
          aria-hidden="true"
          className={cn(
            "pointer-events-none mt-1 flex items-center gap-1 rounded-md border border-dashed px-1.5 py-0.5 font-mono text-[11px] tabular-nums",
            allowed ? "border-primary/60 text-primary" : "border-destructive/60 text-destructive",
          )}
        >
          {allowed ? `→ ${targetTime(target, drag.post.scheduledAt, zone)}` : "Too soon"}
        </div>
      ) : null}
    </div>
  );
}
