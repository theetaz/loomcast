import { IdSchema } from "@loomcast/contracts";
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { Page, PageHeader } from "@/components/PageHeader";
import { ReviewQueue } from "@/features/review-queue/ReviewQueue";
import { useTitle } from "@/lib/use-title";

/** `?project=<id>` narrows the queue to one project; anything else is dropped. */
const ReviewSearchSchema = z.object({
  project: IdSchema.optional().catch(undefined),
});

export const Route = createFileRoute("/_app/review/")({
  validateSearch: ReviewSearchSchema,
  staticData: { breadcrumb: "Review" },
  component: ReviewPage,
});

function ReviewPage() {
  useTitle("Review");
  const { project } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <Page className="max-w-[960px]">
      <PageHeader
        title="Review"
        description="Videos waiting for your decision, the nearest publishing date first."
      />
      <ReviewQueue
        projectId={project ?? null}
        onProjectChange={(next) =>
          void navigate({ search: next ? { project: next } : {}, replace: true })
        }
      />
    </Page>
  );
}
