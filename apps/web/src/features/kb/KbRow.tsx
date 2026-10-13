import type { KbEntry, KbSearchHit } from "@loomcast/contracts";
import { Skeleton } from "@loomcast/ui/components/skeleton";
import { cn } from "@loomcast/ui/lib/cn";
import { Link } from "@tanstack/react-router";
import { RelativeTime } from "@/components/RelativeTime";
import { Snippet } from "@/lib/snippet";
import { KIND_META } from "./kinds";

const rowLink = cn(
  "flex items-center gap-2.5 px-3.5 outline-none transition-colors",
  "hover:bg-secondary focus-visible:bg-secondary focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
);

/** A 36px row: kind icon, title, up to two tags and the age. The list draws the dividers. */
export function KbRow({ entry, projectParam }: { entry: KbEntry; projectParam: string }) {
  const meta = KIND_META[entry.kind];
  const Icon = meta.icon;
  return (
    <Link
      to="/projects/$projectId/kb/$entryId"
      params={{ projectId: projectParam, entryId: entry.id }}
      className={cn(rowLink, "h-9")}
    >
      <Icon aria-hidden="true" className={cn("size-3.5 shrink-0", meta.tone)} />
      <span className="sr-only">{meta.label}:</span>
      <span className="min-w-0 flex-1 truncate text-body text-foreground">{entry.title}</span>
      {entry.tags.length > 0 ? (
        <span className="hidden max-w-[34%] shrink-0 items-center gap-1 overflow-hidden sm:flex">
          {entry.tags.slice(0, 2).map((tag) => (
            <span
              key={tag}
              className="truncate rounded-full bg-secondary px-1.5 font-mono text-[10.5px] text-muted-foreground leading-[18px] shadow-[0_0_0_1px_var(--border)]"
            >
              #{tag}
            </span>
          ))}
          {entry.tags.length > 2 ? (
            <span className="font-mono text-[10.5px] text-muted-foreground">
              +{entry.tags.length - 2}
            </span>
          ) : null}
        </span>
      ) : null}
      <span className="sr-only">updated</span>
      <RelativeTime
        value={entry.updatedAt}
        className="w-11 shrink-0 text-right font-mono text-[11px] text-muted-foreground"
      />
    </Link>
  );
}

/** A search result: kind icon and title, with the matched passage below. */
export function KbHitRow({ hit, projectParam }: { hit: KbSearchHit; projectParam: string }) {
  const meta = KIND_META[hit.kind];
  const Icon = meta.icon;
  return (
    <Link
      to="/projects/$projectId/kb/$entryId"
      params={{ projectId: projectParam, entryId: hit.entryId }}
      className={cn(rowLink, "items-start py-2")}
    >
      <Icon aria-hidden="true" className={cn("mt-[3px] size-3.5 shrink-0", meta.tone)} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-body text-foreground">
          <span className="sr-only">{meta.label}: </span>
          {hit.title}
        </span>
        {hit.snippet ? (
          <Snippet
            text={hit.snippet}
            className="line-clamp-2 break-words text-small text-muted-foreground"
          />
        ) : null}
      </span>
    </Link>
  );
}

const SKELETON_WIDTHS = ["54%", "40%", "62%", "34%", "48%", "44%"];

export function KbRowsSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div aria-hidden="true">
      {SKELETON_WIDTHS.slice(0, rows).map((width) => (
        <div
          key={width}
          className="flex h-9 items-center gap-2.5 border-divider border-t px-3.5 first:border-t-0"
        >
          <Skeleton className="size-3.5 rounded-sm" />
          <div className="flex-1">
            <Skeleton className="h-3" style={{ width }} />
          </div>
          <Skeleton className="hidden h-2.5 w-20 sm:block" />
          <Skeleton className="h-2.5 w-7" />
        </div>
      ))}
    </div>
  );
}
