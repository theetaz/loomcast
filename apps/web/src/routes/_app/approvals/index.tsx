import { IdSchema } from "@loomcast/contracts";
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { Page, PageHeader } from "@/components/PageHeader";
import { ApprovalsInbox } from "@/features/approvals/ApprovalsInbox";
import { useTitle } from "@/lib/use-title";

/** `?project=<id>` narrows the inbox to one project; anything else is dropped. */
const ApprovalsSearchSchema = z.object({
  project: IdSchema.optional().catch(undefined),
});

export const Route = createFileRoute("/_app/approvals/")({
  validateSearch: ApprovalsSearchSchema,
  staticData: { breadcrumb: "Approvals" },
  component: ApprovalsPage,
});

function ApprovalsPage() {
  useTitle("Approvals");
  const { project } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <Page className="max-w-[960px]">
      <PageHeader
        title="Approvals"
        description="Videos waiting for a decision before their slot, the nearest first, and posts that missed theirs."
      />
      <ApprovalsInbox
        projectId={project ?? null}
        onProjectChange={(next) =>
          void navigate({ search: next ? { project: next } : {}, replace: true })
        }
      />
    </Page>
  );
}
