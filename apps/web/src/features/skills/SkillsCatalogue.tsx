import type { SkillUsage } from "@loomcast/contracts";
import { Badge } from "@loomcast/ui/components/badge";
import { Skeleton } from "@loomcast/ui/components/skeleton";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { PuzzleIcon } from "lucide-react";
import { useMemo } from "react";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { Page, PageHeader } from "@/components/PageHeader";
import { RelativeTime } from "@/components/RelativeTime";
import {
  type CatalogueRow,
  catalogueRows,
  isSkillName,
  skillsListQueryOptions,
  skillUsageAllQueryOptions,
  useSkillsLive,
} from "./queries";

export function itemCount(count: number): string {
  return `${count} ${count === 1 ? "item" : "items"}`;
}

/**
 * Every skill and recipe in the registry with its latest version and how many items' production
 * used it, then the skill names producers reported that the registry does not have.
 */
export function SkillsCatalogue() {
  useSkillsLive();
  const skills = useQuery(skillsListQueryOptions());
  const usage = useQuery(skillUsageAllQueryOptions());
  const { rows, unregistered } = useMemo(
    () => catalogueRows(skills.data ?? [], usage.data ?? []),
    [skills.data, usage.data],
  );

  return (
    <Page>
      <PageHeader
        title="Skills"
        description="The skills and recipes producers load, their versions, and the content they helped make."
      />
      <section aria-label="Skills" className="overflow-hidden rounded-lg bg-card shadow-card">
        {skills.isPending ? (
          <CatalogueSkeleton />
        ) : skills.isError ? (
          <ErrorState
            size="compact"
            title="Couldn't load the skills"
            error={skills.error}
            onRetry={() => void skills.refetch()}
            retrying={skills.isFetching}
          />
        ) : rows.length === 0 ? (
          <EmptyState
            size="compact"
            icon={PuzzleIcon}
            title="No skills published yet"
            description="Skills appear here once they are published with skill.publish or skills:seed. For Content Machine, run cm skills sync."
          />
        ) : (
          <table className="w-full table-fixed border-collapse text-left">
            <caption className="sr-only">Skills in the registry</caption>
            <thead>
              <tr className="h-8 border-divider border-b text-small text-muted-foreground">
                <th scope="col" className="px-2 pl-3.5 font-medium">
                  Name
                </th>
                <th scope="col" className="w-[84px] px-2 font-medium">
                  Kind
                </th>
                <th scope="col" className="hidden w-[72px] px-2 font-medium sm:table-cell">
                  Version
                </th>
                <th scope="col" className="hidden w-[96px] px-2 font-medium md:table-cell">
                  Updated
                </th>
                <th scope="col" className="w-[96px] px-2 pr-3.5 text-right font-medium">
                  Used in
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <CatalogueRowView key={row.skill.id} row={row} usageLoading={usage.isPending} />
              ))}
            </tbody>
          </table>
        )}
      </section>
      {unregistered.length > 0 ? <Unregistered usage={unregistered} /> : null}
    </Page>
  );
}

function CatalogueRowView({ row, usageLoading }: { row: CatalogueRow; usageLoading: boolean }) {
  const { skill } = row;
  return (
    <tr className="relative border-divider border-b transition-colors last:border-b-0 hover:bg-accent has-[a:focus-visible]:bg-accent">
      <td className="px-2 py-2.5 pl-3.5">
        <Link
          to="/skills/$name"
          params={{ name: skill.name }}
          className="font-medium font-mono text-[13px] text-foreground outline-none after:absolute after:inset-0 after:content-['']"
        >
          {skill.name}
        </Link>
        {skill.description ? (
          <p className="line-clamp-2 text-control text-muted-foreground">{skill.description}</p>
        ) : null}
      </td>
      <td className="px-2 py-2.5">
        <Badge variant={skill.kind === "recipe" ? "default" : "secondary"}>{skill.kind}</Badge>
      </td>
      <td className="hidden px-2 py-2.5 font-mono text-small text-text-2 tabular-nums sm:table-cell">
        v{skill.latestVersion}
      </td>
      <td className="hidden px-2 py-2.5 text-small text-muted-foreground md:table-cell">
        <RelativeTime value={skill.updatedAt} />
      </td>
      <td className="px-2 py-2.5 pr-3.5 text-right text-small tabular-nums">
        {usageLoading ? (
          <Skeleton className="ml-auto h-3.5 w-12" />
        ) : row.items > 0 ? (
          <span className="text-foreground">{itemCount(row.items)}</span>
        ) : (
          <span className="text-text-4">Unused</span>
        )}
      </td>
    </tr>
  );
}

/** Names producers reported as skills that no registry skill has. */
function Unregistered({ usage }: { usage: readonly SkillUsage[] }) {
  return (
    <section aria-labelledby="skills-unregistered" className="flex flex-col gap-2">
      <div className="flex flex-col gap-0.5">
        <h2 id="skills-unregistered" className="text-heading text-foreground">
          Not in the registry
        </h2>
        <p className="text-control text-muted-foreground">
          Producers reported these skills, but no version of them has been published.
        </p>
      </div>
      <ul className="overflow-hidden rounded-lg bg-card shadow-card">
        {usage.map((entry) => (
          <li
            key={entry.name}
            className="flex items-center gap-3 border-divider border-b px-3.5 py-2.5 last:border-b-0"
          >
            {isSkillName(entry.name) ? (
              <Link
                to="/skills/$name"
                params={{ name: entry.name }}
                className="min-w-0 truncate rounded-sm font-mono text-[13px] text-foreground underline decoration-border underline-offset-2 outline-none hover:decoration-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                {entry.name}
              </Link>
            ) : (
              <span className="min-w-0 truncate font-mono text-[13px] text-foreground">
                {entry.name}
              </span>
            )}
            <span className="ml-auto shrink-0 text-small text-muted-foreground tabular-nums">
              {itemCount(entry.items)}, last <RelativeTime value={entry.lastUsedAt} />
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function CatalogueSkeleton() {
  return (
    <div aria-busy="true" className="flex flex-col">
      {[0, 1, 2, 3].map((row) => (
        <div key={row} className="flex h-14 items-center gap-3 border-divider border-b px-3.5">
          <Skeleton className="h-3.5 w-40" />
          <Skeleton className="ml-auto h-3.5 w-16" />
        </div>
      ))}
    </div>
  );
}
