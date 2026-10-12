import { cn } from "@loomcast/ui/lib/cn";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

export interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  /** `compact` fits inside a card or a filtered list. */
  size?: "default" | "compact";
  className?: string;
}

/** A centred explanation for a place with nothing in it yet, with the next step. */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  size = "default",
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center text-center",
        size === "default" ? "gap-3 px-6 py-14" : "gap-2.5 px-4 py-8",
        className,
      )}
    >
      <span className="flex size-9 items-center justify-center rounded-lg bg-card text-muted-foreground shadow-card">
        <Icon aria-hidden="true" className="size-4" />
      </span>
      <div className="flex max-w-sm flex-col gap-1">
        <p className="text-heading text-foreground">{title}</p>
        {description ? (
          <p className="text-control text-muted-foreground text-pretty">{description}</p>
        ) : null}
      </div>
      {action ? <div className="mt-1 flex flex-wrap justify-center gap-2">{action}</div> : null}
    </div>
  );
}
