import { cn } from "@loomcast/ui/lib/cn";
import { formatAge, formatDateTime, formatRelative } from "@/lib/format";
import { useNow } from "@/lib/use-now";

export interface RelativeTimeProps {
  value: string;
  /** `age` is the compact `3h` of dense rows; `relative` reads as `3 hours ago`. */
  format?: "age" | "relative";
  className?: string;
}

/** A timestamp that stays current. The full date is in the tooltip and the `datetime`. */
export function RelativeTime({ value, format = "age", className }: RelativeTimeProps) {
  const now = useNow();
  const text = format === "age" ? formatAge(value, now) : formatRelative(value, now);
  return (
    <time dateTime={value} title={formatDateTime(value)} className={cn("tabular-nums", className)}>
      {text}
    </time>
  );
}
