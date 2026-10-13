import type { SeriesStatus } from "@loomcast/contracts";
import { cn } from "@loomcast/ui/lib/cn";

const STYLES: Record<SeriesStatus, { label: string; className: string; tone: string }> = {
  active: { label: "Active", className: "bg-status-green/11 text-status-green", tone: "green" },
  paused: { label: "Paused", className: "bg-status-amber/11 text-status-amber", tone: "amber" },
  archived: { label: "Archived", className: "bg-status-gray/11 text-status-gray", tone: "gray" },
};

/** A series' status in the status-pill style: green active, amber paused, gray archived. */
export function SeriesStatusBadge({
  status,
  className,
}: {
  status: SeriesStatus;
  className?: string;
}) {
  const style = STYLES[status];
  return (
    <span
      data-status={status}
      data-tone={style.tone}
      className={cn(
        "inline-flex h-[21px] shrink-0 items-center gap-[5px] whitespace-nowrap rounded-full px-[7px] font-medium text-[11.5px]",
        "before:size-1.5 before:shrink-0 before:rounded-full before:bg-current before:content-['']",
        style.className,
        className,
      )}
    >
      {style.label}
    </span>
  );
}
