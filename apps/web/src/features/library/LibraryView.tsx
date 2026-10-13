import type { ContentItem, CursorPage } from "@loomcast/contracts";
import { Button } from "@loomcast/ui/components/button";
import {
  type InfiniteData,
  type UseInfiniteQueryResult,
  useInfiniteQuery,
} from "@tanstack/react-query";
import { FilterXIcon, LibraryBigIcon, PlusIcon } from "lucide-react";
import { type ReactNode, useCallback, useMemo } from "react";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { nextSort, sortItems } from "./items";
import { LibraryFilters } from "./LibraryFilters";
import { LibraryTable, LibraryTableSkeleton } from "./LibraryTable";
import { NewIdeaDialog } from "./NewIdeaDialog";
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

export interface LibraryViewProps {
  /** The project of a Content tab; `null` for the library across projects. */
  projectId: string | null;
  search: LibrarySearch;
  onSearchChange: (next: LibrarySearch) => void;
}

/**
 * Content items with their filters: the Library page across projects, or a project's Content
 * tab. Filters and sort live in the address; `content.*` events keep the rows current.
 */
export function LibraryView({ projectId, search, onSearchChange }: LibraryViewProps) {
  useContentLive();
  const filter = useMemo(() => filterFromSearch(search, projectId), [search, projectId]);
  const sort = search.sort ?? DEFAULT_LIBRARY_SORT;
  const series = useSeriesOptions(projectId);
  const seriesName = useCallback((id: string) => series.byId.get(id)?.name, [series.byId]);

  const list = useInfiniteQuery(contentListQueryOptions(filter));
  const loaded = useMemo(() => list.data?.pages.flatMap((page) => page.items) ?? [], [list.data]);
  const items = useMemo(() => sortItems(loaded, sort, seriesName), [loaded, sort, seriesName]);

  const changeFilter = (next: LibraryFilter) => onSearchChange(searchFromFilter(next, sort));

  return (
    <section
      aria-label="Videos"
      aria-busy={list.isPending || undefined}
      className="overflow-hidden rounded-lg bg-card shadow-card"
    >
      <LibraryFilters filter={filter} onChange={changeFilter} series={series.options} />
      <p aria-live="polite" className="sr-only">
        {list.data ? `${loaded.length} ${loaded.length === 1 ? "video" : "videos"}` : ""}
      </p>
      <ListBody
        list={list}
        filter={filter}
        onClearFilters={() =>
          changeFilter({ ...filter, states: [], seriesId: null, from: null, to: null, q: "" })
        }
        emptyAction={
          <NewIdeaDialog projectId={projectId}>
            <Button variant="outline">
              <PlusIcon aria-hidden="true" />
              New idea
            </Button>
          </NewIdeaDialog>
        }
      >
        <LibraryTable
          items={items}
          sort={sort}
          seriesName={seriesName}
          onSortChange={(key) => onSearchChange(searchFromFilter(filter, nextSort(sort, key)))}
        />
      </ListBody>
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
