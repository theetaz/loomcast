import type { ContentItemDetail, ContentVersion, PipelineState } from "@loomcast/contracts";
import { Button } from "@loomcast/ui/components/button";
import { Skeleton } from "@loomcast/ui/components/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@loomcast/ui/components/tabs";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { FileQuestionIcon, HistoryIcon } from "lucide-react";
import { useRef } from "react";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { Page } from "@/components/PageHeader";
import { useContentLive } from "@/features/library/use-content-live";
import { isApiError } from "@/lib/api";
import { useTitle } from "@/lib/use-title";
import { itemCards } from "./cards/registry";
import { useItemDecisions } from "./decisions";
import { editBlockedReason } from "./EditNotices";
import { ItemHeader } from "./ItemHeader";
import { JobBanner, LastErrorBanner } from "./JobBanner";
import {
  contentItemQueryOptions,
  reviewsQueryOptions,
  useFormatTarget,
  versionQueryOptions,
} from "./queries";
import { ScriptSkeleton, ScriptTab } from "./ScriptTab";
import type { ItemSearch, ItemTab } from "./search";
import type { ItemTabProps } from "./tab-props";
import { useItemJob } from "./use-item-job";
import { VersionTimeline } from "./VersionTimeline";

const TAB_LABELS: Record<ItemTab, string> = {
  script: "Script",
  storyboard: "Storyboard",
  voice: "Voice",
  video: "Video",
};

/** The tab that shows the furthest a version got: the video once rendered, else its last artifact. */
export function defaultTab(
  version: Pick<ContentVersion, "renderAssetId" | "voiceAssetId" | "hasStoryboard">,
): ItemTab {
  if (version.renderAssetId) return "video";
  if (version.voiceAssetId) return "voice";
  if (version.hasStoryboard) return "storyboard";
  return "script";
}

const EDITABLE_STATES = new Set<PipelineState>([
  "idea",
  "script",
  "storyboard",
  "voice",
  "render",
  "review",
  "approved",
]);

export interface ItemPageProps {
  itemId: string;
  search: ItemSearch;
  onSearchChange: (update: (previous: ItemSearch) => ItemSearch) => void;
}

/**
 * One video: header with its actions, the active job, tabs for script, storyboard, voice and
 * video, and a rail with the review, the version timeline and the producer chat.
 */
export function ItemPage({ itemId, search, onSearchChange }: ItemPageProps) {
  useContentLive();
  const query = useQuery(contentItemQueryOptions(itemId));
  useTitle(query.data?.item.title ?? "Video");

  if (query.isPending) return <ItemPageSkeleton />;
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
  return <ItemView detail={query.data} search={search} onSearchChange={onSearchChange} />;
}

function ItemView({
  detail,
  search,
  onSearchChange,
}: Omit<ItemPageProps, "itemId"> & { detail: ContentItemDetail }) {
  const { item, currentVersion } = detail;
  const commentRef = useRef<HTMLTextAreaElement>(null);
  const { job, activity } = useItemJob(detail);
  const decisions = useItemDecisions(detail, job !== null);
  const reviews = useQuery(reviewsQueryOptions(item.id));
  const format = useFormatTarget(item.seriesId, currentVersion.formatVersionId);

  const otherId =
    search.version && search.version !== currentVersion.id ? search.version : undefined;
  const other = useQuery({
    ...versionQueryOptions(item.id, otherId ?? ""),
    enabled: otherId !== undefined,
  });
  const version: ContentVersion | undefined = otherId ? other.data : currentVersion;
  const viewingCurrent = otherId === undefined;
  const tab = search.tab ?? defaultTab(version ?? currentVersion);

  const canEditState = decisions.can("edit") && EDITABLE_STATES.has(item.state);
  const editBlocked = editBlockedReason({
    canEdit: canEditState,
    viewingCurrent,
    hasActiveJob: job !== null,
  });

  const viewVersion = (id: string) =>
    onSearchChange((previous) => ({
      ...previous,
      version: id === currentVersion.id ? undefined : id,
      compare: undefined,
    }));

  const requestChanges = () => {
    const field = commentRef.current;
    if (!field) return;
    field.scrollIntoView({ block: "center" });
    field.focus();
  };

  const mainCards = itemCards("main");
  const railCards = itemCards("rail");

  return (
    <Page className="max-w-[1240px]">
      <ItemHeader
        item={item}
        series={format.series}
        decisions={decisions}
        onRequestChanges={requestChanges}
      />
      {job ? (
        <JobBanner job={job} activity={activity} />
      ) : item.lastError ? (
        <LastErrorBanner error={item.lastError} />
      ) : null}

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex min-w-0 flex-col gap-5">
          {!viewingCurrent ? (
            <div
              role="status"
              className="flex flex-wrap items-center gap-2 rounded-lg bg-secondary px-3.5 py-2.5 text-body"
            >
              <HistoryIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                {version
                  ? `Showing v${version.versionNo}, an earlier version.`
                  : "Loading the version…"}{" "}
                <span className="text-muted-foreground">Edits start from the current one.</span>
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => viewVersion(currentVersion.id)}
              >
                Show current (v{currentVersion.versionNo})
              </Button>
            </div>
          ) : null}
          <Tabs
            value={tab}
            onValueChange={(value) =>
              onSearchChange((previous) => ({ ...previous, tab: value as ItemTab }))
            }
            className="gap-0 rounded-lg bg-card shadow-card"
          >
            <div className="flex h-11 items-center border-divider border-b px-3">
              <TabsList aria-label="Parts of the video">
                {(Object.keys(TAB_LABELS) as ItemTab[]).map((key) => (
                  <TabsTrigger key={key} value={key}>
                    {TAB_LABELS[key]}
                  </TabsTrigger>
                ))}
              </TabsList>
            </div>
            {version ? (
              <ItemTabs
                tab={tab}
                props={{
                  detail,
                  version,
                  viewingCurrent,
                  canEdit: editBlocked === null,
                  editBlocked,
                  decisions,
                  rules: format.rules,
                }}
                compareId={search.compare}
                onCompare={(id) =>
                  onSearchChange((previous) => ({ ...previous, tab: "script", compare: id }))
                }
              />
            ) : other.isError ? (
              <ErrorState
                size="compact"
                title="Couldn't load that version"
                error={other.error}
                onRetry={() => void other.refetch()}
                retrying={other.isFetching}
              />
            ) : (
              <ScriptSkeleton />
            )}
          </Tabs>
          {mainCards.map(({ id, component: Card }) => (
            <Card key={id} detail={detail} />
          ))}
        </div>

        <aside aria-label="Review, versions and chat" className="flex min-w-0 flex-col gap-5">
          {railCards.map(({ id, component: Card }) => (
            <Card key={id} detail={detail} />
          ))}
          <VersionTimeline
            versions={detail.versions}
            currentVersionId={currentVersion.id}
            viewedVersionId={version?.id ?? otherId ?? currentVersion.id}
            reviews={reviews.data ?? []}
            onView={viewVersion}
            onCompare={(id) =>
              onSearchChange((previous) => ({ ...previous, tab: "script", compare: id }))
            }
          />
        </aside>
      </div>
      {decisions.dialogs}
    </Page>
  );
}

function ItemTabs({
  tab,
  props,
  compareId,
  onCompare,
}: {
  tab: ItemTab;
  props: ItemTabProps;
  compareId: string | undefined;
  onCompare: (id?: string) => void;
}) {
  return (
    <>
      <TabsContent value="script">
        {tab === "script" ? (
          <ScriptTab {...props} compareId={compareId} onCompare={onCompare} />
        ) : null}
      </TabsContent>
      <TabsContent value="storyboard">
        {null}
      </TabsContent>
      <TabsContent value="voice">{null}</TabsContent>
      <TabsContent value="video">{null}</TabsContent>
    </>
  );
}

function ItemPageSkeleton() {
  return (
    <Page className="max-w-[1240px]">
      <div aria-hidden="true" className="flex flex-col gap-2">
        <Skeleton className="h-6 w-80 max-w-full" />
        <Skeleton className="h-4 w-56" />
      </div>
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
        <Skeleton aria-hidden="true" className="h-96 rounded-lg" />
        <Skeleton aria-hidden="true" className="h-64 rounded-lg" />
      </div>
    </Page>
  );
}
