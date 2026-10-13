import { Button } from "@loomcast/ui/components/button";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ClipboardCheckIcon } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { Page, PageHeader } from "@/components/PageHeader";
import { useTitle } from "@/lib/use-title";

// Placeholder: the review queue replaces this page.
export const Route = createFileRoute("/_app/review/")({
  staticData: { breadcrumb: "Review" },
  component: ReviewPage,
});

function ReviewPage() {
  useTitle("Review");
  return (
    <Page>
      <PageHeader title="Review" description="Videos waiting for your decision." />
      <EmptyState
        icon={ClipboardCheckIcon}
        title="The review queue is on its way"
        description="Until then, the library lists every video in review."
        action={
          <Button asChild variant="outline">
            <Link to="/library" search={{ states: "review" }}>
              Open videos in review
            </Link>
          </Button>
        }
      />
    </Page>
  );
}
