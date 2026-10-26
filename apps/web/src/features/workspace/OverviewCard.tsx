import { Skeleton } from "@loomcast/ui/components/skeleton";
import { type ReactNode, useId } from "react";

/** A card on the Overview: a 44px header with an optional action, then its rows. */
export function OverviewCard({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section
      aria-labelledby={id}
      className="min-w-0 overflow-hidden rounded-lg bg-card shadow-card"
    >
      <div className="flex h-11 items-center gap-3 border-divider border-b pr-2 pl-3.5">
        <h2 id={id} className="min-w-0 flex-1 truncate font-semibold text-[13px]">
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

const WIDTHS = ["62%", "48%", "56%"];

export function OverviewRowsSkeleton() {
  return (
    <div aria-hidden="true">
      {WIDTHS.map((width) => (
        <div
          key={width}
          className="flex h-9 items-center gap-2.5 border-divider border-t px-3.5 first:border-t-0"
        >
          <Skeleton className="size-3.5 rounded-sm" />
          <div className="flex-1">
            <Skeleton className="h-3" style={{ width }} />
          </div>
          <Skeleton className="h-2.5 w-7" />
        </div>
      ))}
    </div>
  );
}
