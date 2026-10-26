import { Button } from "@loomcast/ui/components/button";
import { createFileRoute } from "@tanstack/react-router";
import { ImagePlusIcon, PlusIcon } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { NewPostDialog } from "@/features/composer/NewPostDialog";
import { LibraryView } from "@/features/library/LibraryView";
import { NewIdeaDialog } from "@/features/library/NewIdeaDialog";
import { LibrarySearchSchema } from "@/features/library/search";
import { WorkspacePage } from "@/features/workspace/WorkspaceLayout";

export const Route = createFileRoute("/_app/w/$workspace/library")({
  validateSearch: LibrarySearchSchema,
  staticData: { breadcrumb: "Library" },
  component: LibraryPage,
});

function LibraryPage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();

  return (
    <WorkspacePage title="Library" className="max-w-[1240px]">
      {(workspace) => (
        <>
          <PageHeader
            title="Library"
            description="This workspace's videos and posts, from first idea to published."
            actions={
              workspace.status === "active" ? (
                <>
                  <NewPostDialog workspaceId={workspace.id}>
                    <Button variant="outline">
                      <ImagePlusIcon aria-hidden="true" />
                      New post
                    </Button>
                  </NewPostDialog>
                  <NewIdeaDialog workspaceId={workspace.id}>
                    <Button>
                      <PlusIcon aria-hidden="true" />
                      New idea
                    </Button>
                  </NewIdeaDialog>
                </>
              ) : null
            }
          />
          <LibraryView
            key={workspace.id}
            workspaceId={workspace.id}
            search={search}
            onSearchChange={(next) => void navigate({ search: next, replace: true })}
          />
        </>
      )}
    </WorkspacePage>
  );
}
