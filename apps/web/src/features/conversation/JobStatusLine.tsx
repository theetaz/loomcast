import { Button } from "@loomcast/ui/components/button";
import type { StatusTone } from "@loomcast/ui/components/StatusPill";
import { cn } from "@loomcast/ui/lib/cn";
import { RotateCwIcon, SquareIcon } from "lucide-react";
import type { JobStatusView } from "./job-status";

// Full class names so Tailwind finds them.
const TONE: Record<StatusTone, string> = {
  gray: "text-status-gray",
  amber: "text-status-amber",
  violet: "text-status-violet",
  blue: "text-status-blue",
  green: "text-status-green",
  red: "text-status-red",
};

export interface JobStatusLineProps {
  view: JobStatusView;
  onCancel: () => void;
  cancelling: boolean;
  onRetry: () => void;
  retryDisabled: boolean;
}

/**
 * Where the reply stands: queued, waiting for the studio agent, running with
 * its latest activity, or stopped with a way to try again. It sits on top of
 * the composer so Cancel and Retry stay in reach wherever the reader scrolled.
 */
export function JobStatusLine({
  view,
  onCancel,
  cancelling,
  onRetry,
  retryDisabled,
}: JobStatusLineProps) {
  return (
    <div className="flex min-h-7 items-center gap-2 px-1 text-small">
      <div role="status" className="flex min-w-0 flex-1 items-center gap-2">
        <span
          aria-hidden="true"
          className={cn(
            "size-1.5 shrink-0 rounded-full bg-current",
            TONE[view.tone],
            view.active && "animate-pulse",
          )}
        />
        <p className="line-clamp-2 min-w-0 break-words text-text-2">
          <span className={cn("font-medium", TONE[view.tone])}>{view.label}</span>
          {view.detail ? (
            <>
              {" · "}
              <span className="text-muted-foreground">{view.detail}</span>
            </>
          ) : null}
        </p>
      </div>
      {view.canCancel ? (
        <Button type="button" variant="ghost" size="xs" onClick={onCancel} disabled={cancelling}>
          <SquareIcon aria-hidden="true" />
          Cancel
        </Button>
      ) : null}
      {view.canRetry ? (
        <Button
          type="button"
          variant="outline"
          size="xs"
          onClick={onRetry}
          disabled={retryDisabled}
        >
          <RotateCwIcon aria-hidden="true" />
          Retry
        </Button>
      ) : null}
    </div>
  );
}
