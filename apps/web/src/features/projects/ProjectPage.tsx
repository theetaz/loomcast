import type { List, Project } from "@loomcast/contracts";
import { Badge } from "@loomcast/ui/components/badge";
import { Button } from "@loomcast/ui/components/button";
import { Skeleton } from "@loomcast/ui/components/skeleton";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { FolderXIcon } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { Page } from "@/components/PageHeader";
import { RelativeTime } from "@/components/RelativeTime";
import { ConversationPanel } from "@/features/conversation/ConversationPanel";
import { isApiError } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { useTitle } from "@/lib/use-title";
import { ProjectGlyph } from "./ProjectRow";
import { findCachedProject, projectQueryOptions } from "./queries";

/** The project, shown straight away from the list cache when it is there. */
function useProject(idOrSlug: string) {
  const queryClient = useQueryClient();
  return useQuery({
    ...projectQueryOptions(idOrSlug),
    placeholderData: () =>
      findCachedProject(queryClient.getQueryData<List<Project>>(queryKeys.projects.list), idOrSlug),
  });
}

export function ProjectCrumb({ idOrSlug }: { idOrSlug: string }) {
  const query = useProject(idOrSlug);
  if (query.data) return <>{query.data.name}</>;
  if (query.isPending)
    return <Skeleton aria-hidden="true" className="inline-block h-3 w-28 align-middle" />;
  return <>Project</>;
}

export function ProjectPage({ idOrSlug }: { idOrSlug: string }) {
  const query = useProject(idOrSlug);
  useTitle(query.data?.name ?? "Project");

  if (query.isPending) {
    return (
      <Page className="flex-1">
        <div aria-hidden="true" className="flex items-start gap-3">
          <Skeleton className="mt-1 size-6 rounded-md" />
          <div className="flex flex-1 flex-col gap-2 pt-1">
            <Skeleton className="h-5 w-56 max-w-full" />
            <Skeleton className="h-3 w-40" />
          </div>
        </div>
        <Skeleton aria-hidden="true" className="min-h-[320px] flex-1 rounded-lg" />
      </Page>
    );
  }

  if (query.isError) {
    if (isApiError(query.error, 404)) {
      return (
        <Page className="flex-1 justify-center">
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
      <header className="flex flex-col gap-3">
        <div className="flex items-start gap-3">
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
        </div>
        {project.description ? (
          <p className="max-w-[72ch] whitespace-pre-line break-words text-body text-text-2">
            {project.description}
          </p>
        ) : null}
      </header>
      <ConversationPanel project={project} />
    </Page>
  );
}
