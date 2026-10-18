import { Button } from "@loomcast/ui/components/button";
import { createFileRoute } from "@tanstack/react-router";
import { ImagePlusIcon, PlusIcon } from "lucide-react";
import { Page, PageHeader } from "@/components/PageHeader";
import { NewPostDialog } from "@/features/composer/NewPostDialog";
import { LibraryView } from "@/features/library/LibraryView";
import { NewIdeaDialog } from "@/features/library/NewIdeaDialog";
import { LibrarySearchSchema } from "@/features/library/search";
import { useTitle } from "@/lib/use-title";

export const Route = createFileRoute("/_app/library/")({
  validateSearch: LibrarySearchSchema,
  component: LibraryPage,
});

function LibraryPage() {
  useTitle("Library");
  const search = Route.useSearch();
  const navigate = Route.useNavigate();

  return (
    <Page className="max-w-[1240px]">
      <PageHeader
        title="Library"
        description="Every video and post in every project, from first idea to published."
        actions={
          <>
            <NewPostDialog>
              <Button variant="outline">
                <ImagePlusIcon aria-hidden="true" />
                New post
              </Button>
            </NewPostDialog>
            <NewIdeaDialog>
              <Button>
                <PlusIcon aria-hidden="true" />
                New idea
              </Button>
            </NewIdeaDialog>
          </>
        }
      />
      <LibraryView
        projectId={null}
        search={search}
        onSearchChange={(next) => void navigate({ search: next, replace: true })}
      />
    </Page>
  );
}
