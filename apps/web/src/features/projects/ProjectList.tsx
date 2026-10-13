import type { Project } from "@loomcast/contracts";
import { Button } from "@loomcast/ui/components/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@loomcast/ui/components/tabs";
import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import { ArchiveIcon, FolderIcon, PlusIcon } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { NewProjectDialog } from "./NewProjectDialog";
import { ProjectRow, ProjectRowsSkeleton } from "./ProjectRow";
import { projectsQueryOptions } from "./queries";

export const PROJECT_FILTERS = ["active", "archived", "all"] as const;
export type ProjectFilter = (typeof PROJECT_FILTERS)[number];

const FILTER_LABELS: Record<ProjectFilter, string> = {
  active: "Active",
  archived: "Archived",
  all: "All",
};

function matches(filter: ProjectFilter, project: Project): boolean {
  return filter === "all" || project.status === filter;
}

export interface ProjectListProps {
  filter: ProjectFilter;
  onFilterChange: (filter: ProjectFilter) => void;
}

/** The projects card: a filter header and dense rows, with every loading and empty state. */
export function ProjectList({ filter, onFilterChange }: ProjectListProps) {
  const query = useQuery(projectsQueryOptions());
  const projects = query.data ?? [];
  const count = (value: ProjectFilter) => projects.filter((p) => matches(value, p)).length;

  return (
    <section
      aria-label="Projects"
      aria-busy={query.isPending || undefined}
      className="overflow-hidden rounded-lg bg-card shadow-card"
    >
      <Tabs
        value={filter}
        onValueChange={(value) => onFilterChange(value as ProjectFilter)}
        className="gap-0"
      >
        <div className="flex h-11 items-center gap-3 border-divider border-b pr-2 pl-3.5">
          <h2 className="font-semibold text-[13px]">Projects</h2>
          <TabsList className="ml-auto" aria-label="Filter projects">
            {PROJECT_FILTERS.map((value) => (
              <TabsTrigger key={value} value={value}>
                {FILTER_LABELS[value]}
                {query.isSuccess ? (
                  <span className="font-mono text-[10.5px] text-muted-foreground tabular-nums">
                    {count(value)}
                  </span>
                ) : null}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>

        {PROJECT_FILTERS.map((value) => (
          <TabsContent key={value} value={value} className="min-h-[240px]">
            <ProjectListBody filter={value} query={query} />
          </TabsContent>
        ))}
      </Tabs>
    </section>
  );
}

function ProjectListBody({
  filter,
  query,
}: {
  filter: ProjectFilter;
  query: UseQueryResult<Project[]>;
}) {
  if (query.isPending) return <ProjectRowsSkeleton />;

  if (query.isError) {
    return (
      <ErrorState
        size="compact"
        title="Couldn't load projects"
        error={query.error}
        onRetry={() => void query.refetch()}
        retrying={query.isFetching}
      />
    );
  }

  if (query.data.length === 0) {
    return (
      <EmptyState
        icon={FolderIcon}
        title="No projects yet"
        description="Start one for each series or topic. Conversations, research and videos live inside it."
        action={
          <NewProjectDialog>
            <Button>
              <PlusIcon aria-hidden="true" />
              New project
            </Button>
          </NewProjectDialog>
        }
      />
    );
  }

  const rows = query.data.filter((project) => matches(filter, project));
  if (rows.length === 0) {
    return (
      <EmptyState
        size="compact"
        icon={filter === "archived" ? ArchiveIcon : FolderIcon}
        title={filter === "archived" ? "Nothing archived" : "No active projects"}
        description={
          filter === "archived"
            ? "Archived projects show up here, out of the way but still readable."
            : "Every project is archived. Create a new one to get going again."
        }
      />
    );
  }

  return (
    <ul aria-label={`${FILTER_LABELS[filter]} projects`}>
      {rows.map((project) => (
        <li key={project.id} className="border-divider border-t first:border-t-0">
          <ProjectRow project={project} />
        </li>
      ))}
    </ul>
  );
}
