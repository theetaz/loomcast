import { createFileRoute } from "@tanstack/react-router";
import { LibraryBigIcon } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { Page, PageHeader } from "@/components/PageHeader";
import { LibrarySearchSchema } from "@/features/library/search";
import { useTitle } from "@/lib/use-title";

export const Route = createFileRoute("/_app/library/")({
  validateSearch: LibrarySearchSchema,
  component: LibraryPage,
});

function LibraryPage() {
  useTitle("Library");
  return (
    <Page>
      <PageHeader
        title="Library"
        description="Every video in every project, from first idea to published."
      />
      <EmptyState icon={LibraryBigIcon} title="No videos yet" />
    </Page>
  );
}
