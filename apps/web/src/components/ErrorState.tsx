import { Button } from "@loomcast/ui/components/button";
import { cn } from "@loomcast/ui/lib/cn";
import { RotateCwIcon, TriangleAlertIcon } from "lucide-react";
import type { ReactNode } from "react";
import { errorMessage } from "@/lib/api";

export interface ErrorStateProps {
  title?: string;
  error: unknown;
  onRetry?: () => void;
  retrying?: boolean;
  action?: ReactNode;
  size?: "default" | "compact";
  className?: string;
}

/** What failed, in words, and a way to try again. */
export function ErrorState({
  title = "Couldn't load this",
  error,
  onRetry,
  retrying = false,
  action,
  size = "default",
  className,
}: ErrorStateProps) {
  return (
    <div
      role="alert"
      className={cn(
        "flex flex-col items-center justify-center text-center",
        size === "default" ? "gap-3 px-6 py-14" : "gap-2.5 px-4 py-8",
        className,
      )}
    >
      <span className="flex size-9 items-center justify-center rounded-lg bg-status-red/11 text-status-red">
        <TriangleAlertIcon aria-hidden="true" className="size-4" />
      </span>
      <div className="flex max-w-sm flex-col gap-1">
        <p className="text-heading text-foreground">{title}</p>
        <p className="text-control text-muted-foreground text-pretty">{errorMessage(error)}</p>
      </div>
      {onRetry || action ? (
        <div className="mt-1 flex flex-wrap justify-center gap-2">
          {onRetry ? (
            <Button variant="outline" onClick={onRetry} disabled={retrying}>
              <RotateCwIcon aria-hidden="true" />
              {retrying ? "Retrying…" : "Try again"}
            </Button>
          ) : null}
          {action}
        </div>
      ) : null}
    </div>
  );
}
