import { Button } from "@loomcast/ui/components/button";
import { createFileRoute } from "@tanstack/react-router";
import { PlusIcon } from "lucide-react";
import { LibraryView } from "@/features/library/LibraryView";
import { NewIdeaDialog } from "@/features/library/NewIdeaDialog";
import { LibrarySearchSchema } from "@/features/library/search";
import { ProjectTabBody } from "@/features/project/ProjectLayout";

export const Route = createFileRoute("/_app/projects/$projectId/content")({
  validateSearch: LibrarySearchSchema,
  component: ContentTab,
});

function ContentTab() {
  const { projectId } = Route.useParams();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();

  return (
    <ProjectTabBody idOrSlug={projectId} title="Content">
      {(project) => (
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <h2 className="text-heading">Content</h2>
              <p className="text-control text-muted-foreground">
                This project's videos, from first idea to published.
              </p>
            </div>
            {project.status === "active" ? (
              <NewIdeaDialog projectId={project.id}>
                <Button className="self-start sm:self-auto">
                  <PlusIcon aria-hidden="true" />
                  New idea
                </Button>
              </NewIdeaDialog>
            ) : null}
          </div>
          <LibraryView
            projectId={project.id}
            search={search}
            onSearchChange={(next) => void navigate({ search: next, replace: true })}
          />
        </div>
      )}
    </ProjectTabBody>
  );
}
