import type { Project } from "@loomcast/contracts";
import { Badge } from "@loomcast/ui/components/badge";
import { Skeleton } from "@loomcast/ui/components/skeleton";
import { cn } from "@loomcast/ui/lib/cn";
import { Link } from "@tanstack/react-router";
import { RelativeTime } from "@/components/RelativeTime";
import { initials } from "@/lib/format";

// Full class names so Tailwind finds them. A project keeps its tone for life.
const GLYPH_TONES = [
  "bg-status-blue/11 text-status-blue",
  "bg-status-violet/11 text-status-violet",
  "bg-status-green/11 text-status-green",
  "bg-status-amber/11 text-status-amber",
  "bg-ember/11 text-ember",
] as const;

function toneFor(id: string): string {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
  return GLYPH_TONES[hash % GLYPH_TONES.length] ?? GLYPH_TONES[0];
}

export function ProjectGlyph({ project, className }: { project: Project; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-[18px] shrink-0 items-center justify-center rounded-[5px] font-semibold text-[10px]",
        toneFor(project.id),
        className,
      )}
    >
      {initials(project.name).slice(0, 1)}
    </span>
  );
}

/** A 40px list row: glyph, name, slug in mono, archived badge and age. The list draws the dividers. */
export function ProjectRow({ project }: { project: Project }) {
  return (
    <Link
      to="/projects/$projectId"
      params={{ projectId: project.id }}
      className={cn(
        "flex h-10 items-center gap-3 px-3.5 outline-none transition-colors",
        "hover:bg-secondary focus-visible:bg-secondary focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
      )}
    >
      <ProjectGlyph project={project} />
      <span className="min-w-0 flex-1 truncate text-body text-foreground">{project.name}</span>
      <span className="hidden max-w-[38%] truncate font-mono text-mono text-muted-foreground sm:block">
        {project.slug}
      </span>
      {project.status === "archived" ? <Badge variant="secondary">Archived</Badge> : null}
      <span className="sr-only">updated</span>
      <RelativeTime
        value={project.updatedAt}
        className="w-11 shrink-0 text-right font-mono text-[11px] text-muted-foreground"
      />
    </Link>
  );
}

const SKELETON_WIDTHS = ["58%", "42%", "66%", "36%", "50%", "45%"];

export function ProjectRowsSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div aria-hidden="true">
      {SKELETON_WIDTHS.slice(0, rows).map((width) => (
        <div
          key={width}
          className="flex h-10 items-center gap-3 border-divider border-t px-3.5 first:border-t-0"
        >
          <Skeleton className="size-[18px] rounded-[5px]" />
          <div className="flex-1">
            <Skeleton className="h-3" style={{ width }} />
          </div>
          <Skeleton className="hidden h-2.5 w-24 sm:block" />
          <Skeleton className="h-2.5 w-7" />
        </div>
      ))}
    </div>
  );
}
