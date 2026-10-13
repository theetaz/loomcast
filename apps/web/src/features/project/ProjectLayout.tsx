import type { Project } from "@loomcast/contracts";
import { Badge } from "@loomcast/ui/components/badge";
import { Button } from "@loomcast/ui/components/button";
import { Skeleton } from "@loomcast/ui/components/skeleton";
import { Link, Outlet } from "@tanstack/react-router";
import { FolderXIcon } from "lucide-react";
import type { ReactNode } from "react";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { Page } from "@/components/PageHeader";
import { RelativeTime } from "@/components/RelativeTime";
import { ProjectGlyph } from "@/features/projects/ProjectRow";
import { isApiError } from "@/lib/api";
import { useTitle } from "@/lib/use-title";
import { useProject } from "./queries";
import { ProjectTabs } from "./tabs/ProjectTabs";

export function ProjectCrumb({ idOrSlug }: { idOrSlug: string }) {
  const query = useProject(idOrSlug);
  if (query.data) return <>{query.data.name}</>;
  if (query.isPending)
    return <Skeleton aria-hidden="true" className="inline-block h-3 w-28 align-middle" />;
  return <>Project</>;
}

/**
 * The project page: its header and tabs, with the open tab below. Loading, not-found and error
 * states cover the whole page, so tabs only render once the project is known.
 */
export function ProjectLayout({ idOrSlug }: { idOrSlug: string }) {
  const query = useProject(idOrSlug);

  if (query.isPending) {
    return (
      <Page className="flex-1">
        <ProjectTitle page="Project" />
        <div aria-hidden="true" className="flex items-start gap-3">
          <Skeleton className="mt-1 size-6 rounded-md" />
          <div className="flex flex-1 flex-col gap-2 pt-1">
            <Skeleton className="h-5 w-56 max-w-full" />
            <Skeleton className="h-3 w-40" />
          </div>
        </div>
        <Skeleton aria-hidden="true" className="h-7 w-64 max-w-full rounded-[8px]" />
        <Skeleton aria-hidden="true" className="min-h-[320px] flex-1 rounded-lg" />
      </Page>
    );
  }

  if (query.isError) {
    if (isApiError(query.error, 404)) {
      return (
        <Page className="flex-1 justify-center">
          <ProjectTitle page="Project not found" />
          <EmptyState
            icon={FolderXIcon}
            title="Project not found"
            description="It may have been removed, or the link points somewhere else."
            action={
              <Button asChild variant="outline">
                <Link to="/projects">All projects</Link>
              </Button>
            }
          />
        </Page>
      );
    }
    return (
      <Page className="flex-1 justify-center">
        <ProjectTitle page="Project" />
        <ErrorState
          title="Couldn't load this project"
          error={query.error}
          onRetry={() => void query.refetch()}
          retrying={query.isFetching}
        />
      </Page>
    );
  }

  const project = query.data;
  return (
    <Page className="flex-1">
      <ProjectHeader project={project} />
      <ProjectTabs projectParam={idOrSlug}>
        <Outlet />
      </ProjectTabs>
    </Page>
  );
}

function ProjectTitle({ page }: { page: string }) {
  useTitle(page);
  return null;
}

function ProjectHeader({ project }: { project: Project }) {
  return (
    <header className="flex items-start gap-3">
      <ProjectGlyph project={project} className="mt-[3px] size-6 rounded-md text-[12px]" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <h1 className="text-title break-words">{project.name}</h1>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-small text-muted-foreground">
          <code className="max-w-full truncate font-mono text-mono">{project.slug}</code>
          <span aria-hidden="true">·</span>
          <span>
            Updated <RelativeTime value={project.updatedAt} format="relative" />
          </span>
          {project.status === "archived" ? <Badge variant="secondary">Archived</Badge> : null}
        </div>
      </div>
    </header>
  );
}

/**
 * The body of one tab. The layout has already loaded the project, so this reads it from the
 * cache, and sets the document title to `<tab> · <project>`.
 */
export function ProjectTabBody({
  idOrSlug,
  title,
  children,
}: {
  idOrSlug: string;
  title?: string;
  children: (project: Project) => ReactNode;
}) {
  const { data: project } = useProject(idOrSlug);
  useTitle(project ? (title ? `${title} · ${project.name}` : project.name) : title);
  return project ? children(project) : null;
}
