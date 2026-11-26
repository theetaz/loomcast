import {
  type FormatRecipeUsage,
  PROGRESS_STEP_LABELS,
  type ProgressNameUsage,
  type SkillUsage,
} from "@loomcast/contracts";
import { Badge } from "@loomcast/ui/components/badge";
import { Skeleton } from "@loomcast/ui/components/skeleton";
import { useQuery } from "@tanstack/react-query";
import { PuzzleIcon, WrenchIcon } from "lucide-react";
import type { ReactNode } from "react";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { RelativeTime } from "@/components/RelativeTime";
import { useProgressLive } from "@/features/production/queries";
import { SkillName, toolAnchor } from "./links";
import { useSkillsLive, workspaceSkillsQueryOptions } from "./queries";
import { itemCount } from "./SkillsCatalogue";

/**
 * The skills and tools a workspace's production used, as its producers reported them, and the
 * recipes its formats name.
 */
export function WorkspaceSkills({ workspaceId }: { workspaceId: string }) {
  useProgressLive();
  useSkillsLive();
  const query = useQuery(workspaceSkillsQueryOptions(workspaceId));

  if (query.isError) {
    return (
      <ErrorState
        title="Couldn't load the skills and tools"
        error={query.error}
        onRetry={() => void query.refetch()}
        retrying={query.isFetching}
      />
    );
  }
  if (query.isPending) {
    return <Skeleton aria-busy="true" className="h-80 rounded-lg" />;
  }
  const { skills, tools, recipes } = query.data;

  return (
    <div className="flex flex-col gap-6">
      <UsageSection
        id="workspace-skills"
        title="Skills"
        description="The skills that guided each production step."
        usage={skills}
        empty={
          <EmptyState
            size="compact"
            icon={PuzzleIcon}
            title="No skills reported yet"
            description="Skills show up here once a producer reports the steps it made with them. For Content Machine, run cm content sync."
          />
        }
        renderName={(entry) => <SkillName name={entry.name} />}
        renderExtra={(entry) => <RegistryBadge entry={entry as SkillUsage} />}
      />
      <UsageSection
        id="workspace-tools"
        title="Tools"
        description="The commands and tools that did the work."
        usage={tools}
        empty={
          <EmptyState
            size="compact"
            icon={WrenchIcon}
            title="No tools reported yet"
            description="Tools show up here once a producer reports the commands behind its steps."
          />
        }
        renderName={(entry) => (
          <span className="font-mono text-[13px] text-foreground">{entry.name}</span>
        )}
        rowId={(entry) => toolAnchor(entry.name)}
      />
      {recipes.length > 0 ? <Recipes recipes={recipes} /> : null}
    </div>
  );
}

function RegistryBadge({ entry }: { entry: SkillUsage }) {
  return entry.registry ? (
    <Badge variant="secondary">
      {entry.registry.kind} v{entry.registry.latestVersion}
    </Badge>
  ) : (
    <Badge variant="outline" title="No version of this skill has been published">
      Not in the registry
    </Badge>
  );
}

function UsageSection({
  id,
  title,
  description,
  usage,
  empty,
  renderName,
  renderExtra,
  rowId,
}: {
  id: string;
  title: string;
  description: string;
  usage: readonly ProgressNameUsage[];
  empty: ReactNode;
  renderName: (entry: ProgressNameUsage) => ReactNode;
  renderExtra?: (entry: ProgressNameUsage) => ReactNode;
  rowId?: (entry: ProgressNameUsage) => string;
}) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2">
      <div className="flex flex-col gap-0.5">
        <h2 id={id} className="text-heading text-foreground">
          {title}
        </h2>
        <p className="text-control text-muted-foreground">{description}</p>
      </div>
      <div className="overflow-hidden rounded-lg bg-card shadow-card">
        {usage.length === 0 ? (
          empty
        ) : (
          <table className="w-full table-fixed border-collapse text-left">
            <caption className="sr-only">{title} used in this workspace</caption>
            <thead>
              <tr className="h-8 border-divider border-b text-small text-muted-foreground">
                <th scope="col" className="px-2 pl-3.5 font-medium">
                  Name
                </th>
                <th scope="col" className="hidden w-[34%] px-2 font-medium md:table-cell">
                  Steps
                </th>
                <th scope="col" className="w-[84px] px-2 text-right font-medium">
                  Items
                </th>
                <th
                  scope="col"
                  className="hidden w-[84px] px-2 pr-3.5 text-right font-medium sm:table-cell"
                >
                  Last used
                </th>
              </tr>
            </thead>
            <tbody>
              {usage.map((entry) => (
                <tr
                  key={entry.name}
                  id={rowId?.(entry)}
                  className="scroll-mt-16 border-divider border-b last:border-b-0 target:bg-accent-soft"
                >
                  <td className="px-2 py-2.5 pl-3.5">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      {renderName(entry)}
                      {renderExtra?.(entry)}
                    </div>
                  </td>
                  <td className="hidden px-2 py-2.5 text-small text-text-2 md:table-cell">
                    {entry.steps.map((key) => PROGRESS_STEP_LABELS[key]).join(", ")}
                  </td>
                  <td className="px-2 py-2.5 text-right text-small text-foreground tabular-nums">
                    {itemCount(entry.items)}
                  </td>
                  <td className="hidden px-2 py-2.5 pr-3.5 text-right text-small text-muted-foreground sm:table-cell">
                    <RelativeTime value={entry.lastUsedAt} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

function Recipes({ recipes }: { recipes: readonly FormatRecipeUsage[] }) {
  return (
    <section aria-labelledby="workspace-recipes" className="flex flex-col gap-2">
      <div className="flex flex-col gap-0.5">
        <h2 id="workspace-recipes" className="text-heading text-foreground">
          Format recipes
        </h2>
        <p className="text-control text-muted-foreground">
          The recipes this workspace's formats name to guide their producer steps.
        </p>
      </div>
      <ul className="overflow-hidden rounded-lg bg-card shadow-card">
        {recipes.map((recipe) => (
          <li
            key={recipe.formatId}
            className="flex flex-wrap items-center gap-2 border-divider border-b px-3.5 py-2.5 last:border-b-0"
          >
            <SkillName name={recipe.name} />
            <span className="text-small text-muted-foreground">
              {recipe.version === null ? "latest version" : `pinned to v${recipe.version}`}
            </span>
            {recipe.registry === null ? (
              <Badge variant="outline">Not in the registry</Badge>
            ) : recipe.version !== null && recipe.version < recipe.registry.latestVersion ? (
              <Badge variant="secondary">v{recipe.registry.latestVersion} available</Badge>
            ) : null}
            <span className="ml-auto text-small text-text-2">{recipe.formatName}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
