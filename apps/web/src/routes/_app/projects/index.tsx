import { Button } from "@loomcast/ui/components/button";
import { createFileRoute } from "@tanstack/react-router";
import { PlusIcon } from "lucide-react";
import { z } from "zod";
import { Page, PageHeader } from "@/components/PageHeader";
import { NewProjectDialog } from "@/features/projects/NewProjectDialog";
import { PROJECT_FILTERS, ProjectList } from "@/features/projects/ProjectList";
import { useTitle } from "@/lib/use-title";

const projectsSearchSchema = z.object({
  status: z.enum(PROJECT_FILTERS).optional().catch(undefined),
});

export const Route = createFileRoute("/_app/projects/")({
  validateSearch: projectsSearchSchema,
  component: ProjectsPage,
});

function ProjectsPage() {
  useTitle("Projects");
  const { status = "active" } = Route.useSearch();
  const navigate = Route.useNavigate();

  return (
    <Page>
      <PageHeader
        title="Projects"
        description="Each project collects the conversations, research and videos for one series."
        actions={
          <NewProjectDialog>
            <Button>
              <PlusIcon aria-hidden="true" />
              New project
            </Button>
          </NewProjectDialog>
        }
      />
      <ProjectList
        filter={status}
        onFilterChange={(next) =>
          void navigate({ search: next === "active" ? {} : { status: next }, replace: true })
        }
      />
    </Page>
  );
}
