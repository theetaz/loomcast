import { Button } from "@loomcast/ui/components/button";
import { createFileRoute } from "@tanstack/react-router";
import { ImagePlusIcon, PlusIcon } from "lucide-react";
import { NewPostDialog } from "@/features/composer/NewPostDialog";
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
                This project's videos and posts, from first idea to published.
              </p>
            </div>
            {project.status === "active" ? (
              <div className="flex items-center gap-2 self-start sm:self-auto">
                <NewPostDialog projectId={project.id}>
                  <Button variant="outline">
                    <ImagePlusIcon aria-hidden="true" />
                    New post
                  </Button>
                </NewPostDialog>
                <NewIdeaDialog projectId={project.id}>
                  <Button>
                    <PlusIcon aria-hidden="true" />
                    New idea
                  </Button>
                </NewIdeaDialog>
              </div>
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
