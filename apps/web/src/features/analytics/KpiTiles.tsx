import { Skeleton } from "@loomcast/ui/components/skeleton";
import { cn } from "@loomcast/ui/lib/cn";
import type { ReactNode } from "react";

export interface Kpi {
  id: string;
  label: string;
  /** Already formatted; `—` when there is nothing to show yet. */
  value: string;
  /** One line of context under the value. */
  detail?: ReactNode;
}

/**
 * A row of stat tiles: sentence-case label, the value in the UI sans with proportional figures,
 * and a line of context. Values are text, so they need no table twin.
 */
export function KpiTiles({ items, busy = false }: { items: readonly Kpi[]; busy?: boolean }) {
  return (
    <dl
      aria-busy={busy || undefined}
      className={cn(
        "grid grid-cols-2 gap-3 transition-opacity duration-150 ease-out motion-reduce:transition-none lg:grid-cols-4",
        busy && "opacity-60",
      )}
    >
      {items.map((item) => (
        <div
          key={item.id}
          className="flex min-w-0 flex-col gap-1 rounded-lg bg-card px-4 py-3 shadow-card"
        >
          <dt className="truncate text-small text-muted-foreground">{item.label}</dt>
          <dd className="text-[22px] leading-7 font-semibold tracking-[-0.02em] text-foreground">
            {item.value}
          </dd>
          {item.detail ? (
            <dd className="truncate text-small text-muted-foreground">{item.detail}</dd>
          ) : null}
        </div>
      ))}
    </dl>
  );
}

export function KpiTilesSkeleton() {
  return (
    <div aria-hidden="true" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {[0, 1, 2, 3].map((index) => (
        <div key={index} className="flex flex-col gap-2 rounded-lg bg-card px-4 py-3 shadow-card">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-6 w-16" />
          <Skeleton className="h-3 w-28" />
        </div>
      ))}
    </div>
  );
}
