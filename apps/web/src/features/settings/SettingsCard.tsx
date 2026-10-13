import { Skeleton } from "@loomcast/ui/components/skeleton";
import { cn } from "@loomcast/ui/lib/cn";
import type { ReactNode } from "react";

export interface SettingsCardProps {
  title: string;
  /** Shown next to the title once the list has loaded. */
  count?: number | null;
  busy?: boolean;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}

/** The list card used across Settings: a 44px header with the title and the primary action. */
export function SettingsCard({
  title,
  count,
  busy,
  action,
  children,
  className,
}: SettingsCardProps) {
  return (
    <section
      aria-label={title}
      aria-busy={busy || undefined}
      className={cn("overflow-hidden rounded-lg bg-card shadow-card", className)}
    >
      <div className="flex h-11 items-center gap-2 border-divider border-b pr-2 pl-3.5">
        <h2 className="font-semibold text-[13px]">{title}</h2>
        {count !== null && count !== undefined ? (
          <span className="font-mono text-[10.5px] text-muted-foreground tabular-nums">
            {count}
          </span>
        ) : null}
        {action ? <div className="ml-auto flex items-center gap-1.5">{action}</div> : null}
      </div>
      {children}
    </section>
  );
}

/** Header cell classes for the dense settings tables. */
export function th(className?: string): string {
  return cn("px-2 align-middle font-medium text-[11.5px] text-muted-foreground", className);
}

/** Body cell classes: 40px rows, content truncates rather than wraps. */
export function td(className?: string): string {
  return cn("overflow-hidden px-2 align-middle", className);
}

const ROW_KEYS = ["a", "b", "c"] as const;

/** Placeholder rows while a table loads; `columns` are the widths of the trailing cells. */
export function TableSkeleton({ columns }: { columns: readonly string[] }) {
  return (
    <div aria-hidden="true">
      <div className="h-9 border-divider border-b" />
      {ROW_KEYS.map((key, row) => (
        <div
          key={key}
          className="flex h-10 items-center gap-4 border-divider border-t px-3.5 first:border-t-0"
        >
          <div className="flex-1">
            <Skeleton className="h-3" style={{ width: `${52 - row * 10}%` }} />
          </div>
          {columns.map((width, index) => (
            <Skeleton
              // Columns are fixed for a given table, so the index is a stable key.
              key={index}
              className={cn("h-2.5", width, index < columns.length - 2 && "max-sm:hidden")}
            />
          ))}
        </div>
      ))}
    </div>
  );
}
