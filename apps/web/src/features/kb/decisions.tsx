import { type DecisionData, type KbEntry, parseKbEntryData } from "@loomcast/contracts";
import { cn } from "@loomcast/ui/lib/cn";

/** A decision's `data`, tolerating rows written before the shape settled. */
export function decisionOf(entry: KbEntry): DecisionData {
  const parsed = parseKbEntryData("decision", entry.data);
  if (parsed.success) return parsed.data;
  return { decision: entry.bodyMd || entry.title, status: "active" };
}

const PILL_STYLES = {
  active: { label: "Active", className: "bg-status-green/11 text-status-green" },
  superseded: { label: "Superseded", className: "bg-status-gray/11 text-status-gray" },
} as const;

/** The status of a decision, styled like the other status pills. */
export function DecisionPill({
  status,
  className,
}: {
  status: DecisionData["status"];
  className?: string;
}) {
  const style = PILL_STYLES[status];
  return (
    <span
      data-slot="status-pill"
      data-status={status}
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
