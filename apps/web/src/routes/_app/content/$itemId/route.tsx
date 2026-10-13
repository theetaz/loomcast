import { IdSchema } from "@loomcast/contracts";
import { Button } from "@loomcast/ui/components/button";
import { StatusPill } from "@loomcast/ui/components/StatusPill";
import { Skeleton } from "@loomcast/ui/components/skeleton";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { FileQuestionIcon, FilmIcon } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { Page } from "@/components/PageHeader";
import { RelativeTime } from "@/components/RelativeTime";
import { ContentCrumb } from "@/features/library/ContentCrumb";
import { contentItemQueryOptions } from "@/features/library/queries";
import { useContentLive } from "@/features/library/use-content-live";
import { isApiError } from "@/lib/api";
import { useTitle } from "@/lib/use-title";

// Placeholder: the item and review screen replaces this page.
export const Route = createFileRoute("/_app/content/$itemId")({
  beforeLoad: ({ params }) => {
    if (!IdSchema.safeParse(params.itemId).success) throw notFound();
  },
  staticData: { breadcrumb: (params) => <ContentCrumb itemId={params.itemId ?? ""} /> },
  component: ContentItemPage,
});

function ContentItemPage() {
  const { itemId } = Route.useParams();
  useContentLive();
  const query = useQuery(contentItemQueryOptions(itemId));
  useTitle(query.data?.item.title ?? "Video");

  if (query.isPending) {
    return (
      <Page>
        <Skeleton aria-hidden="true" className="h-6 w-72 max-w-full" />
        <Skeleton aria-hidden="true" className="h-40 rounded-lg" />
      </Page>
    );
  }
  if (query.isError) {
    return (
      <Page className="flex-1 justify-center">
        {isApiError(query.error, 404) ? (
          <EmptyState
            icon={FileQuestionIcon}
            title="Video not found"
            description="It may have been removed, or the link points somewhere else."
            action={
              <Button asChild variant="outline">
                <Link to="/library">Open the library</Link>
              </Button>
            }
          />
        ) : (
          <ErrorState
            title="Couldn't load this video"
            error={query.error}
            onRetry={() => void query.refetch()}
            retrying={query.isFetching}
          />
        )}
      </Page>
    );
  }

  const { item } = query.data;
  return (
    <Page>
      <header className="flex flex-col gap-1.5">
        <h1 className="text-title break-words">{item.title}</h1>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-small text-muted-foreground">
          <StatusPill kind="pipeline" status={item.state} />
          <span className="font-mono text-mono">v{item.versionNo}</span>
          <span aria-hidden="true">·</span>
          <span>
            Updated <RelativeTime value={item.updatedAt} format="relative" />
          </span>
        </div>
        {item.pitch ? <p className="max-w-prose text-body text-text-2">{item.pitch}</p> : null}
      </header>
      <section className="rounded-lg bg-card shadow-card">
        <EmptyState
          size="compact"
          icon={FilmIcon}
          title="The full video page is on its way"
          description="Script, storyboard, voice, video and review will appear here."
          action={
            <Button asChild variant="outline">
              <Link to="/library">Back to the library</Link>
            </Button>
          }
        />
      </section>
    </Page>
  );
}
