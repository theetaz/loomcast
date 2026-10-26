import type { ContentItem, CursorPage } from "@loomcast/contracts";
import { Button } from "@loomcast/ui/components/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@loomcast/ui/components/tabs";
import {
  type InfiniteData,
  type UseInfiniteQueryResult,
  useInfiniteQuery,
} from "@tanstack/react-query";
import { FilterXIcon, KanbanIcon, LibraryBigIcon, PlusIcon, Rows3Icon } from "lucide-react";
import { type ReactNode, useCallback, useMemo } from "react";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { nextSort, sortItems } from "./items";
import { LibraryFilters } from "./LibraryFilters";
import { LibraryTable, LibraryTableSkeleton } from "./LibraryTable";
import { NewIdeaDialog } from "./NewIdeaDialog";
import { PipelineBoard } from "./PipelineBoard";
import { QuickActions } from "./QuickActions";
import { contentListQueryOptions, useSeriesOptions } from "./queries";
import {
  DEFAULT_LIBRARY_SORT,
  filterFromSearch,
  hasFilters,
  type LibraryFilter,
  type LibrarySearch,
  searchFromFilter,
} from "./search";
import { useContentLive } from "./use-content-live";
import { type LibraryView as LibraryViewMode, useLibraryView } from "./view-preference";

export interface LibraryViewProps {
  /** The workspace whose library this is. */
  workspaceId: string;
  search: LibrarySearch;
  onSearchChange: (next: LibrarySearch) => void;
}

/**
 * A workspace's content items with their filters, as a table or a read-only pipeline board
 * (remembered per browser). Filters and sort live
 * in the address; `content.*` events keep the rows current.
 */
export function LibraryView({ workspaceId, search, onSearchChange }: LibraryViewProps) {
  useContentLive();
  const filter = useMemo(() => filterFromSearch(search, workspaceId), [search, workspaceId]);
  const sort = search.sort ?? DEFAULT_LIBRARY_SORT;
  const series = useSeriesOptions(workspaceId);
  const seriesName = useCallback((id: string) => series.byId.get(id)?.name, [series.byId]);

  const list = useInfiniteQuery(contentListQueryOptions(filter));
  const loaded = useMemo(() => list.data?.pages.flatMap((page) => page.items) ?? [], [list.data]);
  const items = useMemo(() => sortItems(loaded, sort, seriesName), [loaded, sort, seriesName]);

  const changeFilter = (next: LibraryFilter) => onSearchChange(searchFromFilter(next, sort));
  const [view, setView] = useLibraryView();
  const actions = (item: ContentItem) => <QuickActions item={item} />;

  return (
    <section
      aria-label="Videos"
      aria-busy={list.isPending || undefined}
      className="overflow-hidden rounded-lg bg-card shadow-card"
    >
      <Tabs
        value={view}
        onValueChange={(value) => setView(value as LibraryViewMode)}
        className="gap-0"
      >
        <div className="flex h-11 items-center gap-2 border-divider border-b px-2">
          <TabsList aria-label="View">
            <TabsTrigger value="table" className="flex-none">
              <Rows3Icon aria-hidden="true" />
              Table
            </TabsTrigger>
            <TabsTrigger value="board" className="flex-none">
              <KanbanIcon aria-hidden="true" />
              Board
            </TabsTrigger>
          </TabsList>
          <p aria-live="polite" className="ml-auto pr-1.5 text-small text-muted-foreground">
            {list.data
              ? `${loaded.length}${list.hasNextPage ? "+" : ""} ${loaded.length === 1 ? "video" : "videos"}`
              : ""}
          </p>
        </div>
        <LibraryFilters filter={filter} onChange={changeFilter} series={series.options} />
        <TabsContent value={view} tabIndex={-1} className="min-h-[228px]">
          <ListBody
            list={list}
            filter={filter}
            onClearFilters={() =>
              changeFilter({ ...filter, states: [], seriesId: null, from: null, to: null, q: "" })
            }
            emptyAction={
              <NewIdeaDialog workspaceId={workspaceId}>
                <Button variant="outline">
                  <PlusIcon aria-hidden="true" />
                  New idea
                </Button>
              </NewIdeaDialog>
            }
          >
            {view === "board" ? (
              <PipelineBoard
                items={items}
                states={filter.states}
                seriesName={seriesName}
                actions={actions}
              />
            ) : (
              <LibraryTable
                items={items}
                sort={sort}
                seriesName={seriesName}
                onSortChange={(key) =>
                  onSearchChange(searchFromFilter(filter, nextSort(sort, key)))
                }
                actions={actions}
              />
            )}
          </ListBody>
        </TabsContent>
      </Tabs>
    </section>
  );
}

function ListBody({
  list,
  filter,
  onClearFilters,
  emptyAction,
  children,
}: {
  list: UseInfiniteQueryResult<InfiniteData<CursorPage<ContentItem>, unknown>>;
  filter: LibraryFilter;
  onClearFilters: () => void;
  emptyAction: ReactNode;
  children: ReactNode;
}) {
  if (list.isPending) return <LibraryTableSkeleton />;
  if (list.isError) {
    return (
      <ErrorState
        size="compact"
        title="Couldn't load the library"
        error={list.error}
        onRetry={() => void list.refetch()}
        retrying={list.isFetching}
      />
    );
  }
  const count = list.data.pages.reduce((sum, page) => sum + page.items.length, 0);
  if (count === 0) {
    return hasFilters(filter) ? (
      <EmptyState
        size="compact"
        icon={FilterXIcon}
        title="No videos match these filters"
        description="Try another state or series, a wider date range, or fewer words."
        action={
          <Button variant="outline" onClick={onClearFilters}>
            Clear filters
          </Button>
        }
      />
    ) : (
      <EmptyState
        size="compact"
        icon={LibraryBigIcon}
        title="No videos yet"
        description="Every video starts as an idea. Add one, then produce it through review."
        action={emptyAction}
      />
    );
  }
  return (
    <>
      {children}
      {list.hasNextPage ? (
        <div className="flex justify-center border-divider border-t p-2">
          <Button
            variant="ghost"
            onClick={() => void list.fetchNextPage()}
            disabled={list.isFetchingNextPage}
          >
            {list.isFetchingNextPage ? "Loading…" : "Load more"}
          </Button>
        </div>
      ) : null}
    </>
  );
}
