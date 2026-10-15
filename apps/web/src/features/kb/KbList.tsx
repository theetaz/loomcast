import {
  type CursorPage,
  KB_SEARCH_MAX_LIMIT,
  KB_SEARCH_QUERY_MAX_LENGTH,
  type KbEntry,
  type KbSearchHit,
  type Project,
} from "@loomcast/contracts";
import { Button } from "@loomcast/ui/components/button";
import { Input } from "@loomcast/ui/components/input";
import { ScrollArea } from "@loomcast/ui/components/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@loomcast/ui/components/tabs";
import { cn } from "@loomcast/ui/lib/cn";
import {
  type InfiniteData,
  keepPreviousData,
  type UseInfiniteQueryResult,
  type UseQueryResult,
  useInfiniteQuery,
  useQuery,
} from "@tanstack/react-query";
import { type LucideIcon, SearchIcon, SearchXIcon, TagIcon, XIcon } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { KbHitRow, KbRow, KbRowsSkeleton } from "./KbRow";
import { filterLabel, KB_FILTERS, type KbFilter, KIND_META } from "./kinds";
import { kbListQueryOptions, kbSearchQueryOptions, kbTagsQueryOptions } from "./queries";
import { useDebouncedValue } from "./use-debounced-value";

/** Search waits this long after the last keystroke. */
export const KB_SEARCH_DEBOUNCE_MS = 200;

/** Tag chips shown before the rest hide behind "More tags". */
const VISIBLE_TAGS = 12;

/** The list's state, kept in the address so Back and shared links restore it. */
export interface KbListState {
  kind: KbFilter;
  tag: string | null;
  q: string;
}

export interface KbListProps {
  project: Project;
  /** The project as it appears in the address: its id or slug. */
  projectParam: string;
  state: KbListState;
  onStateChange: (next: KbListState) => void;
  /** The next step in an empty list, such as a "New brainstorm" button. */
  emptyAction?: (kind: KbFilter) => ReactNode;
  /** Replaces the rows for one kind, such as the decision timeline. */
  renderKind?: Partial<Record<KbFilter, () => ReactNode>>;
}

/**
 * The knowledge card: a kind filter, search and tag chips over dense rows. Without a query it
 * pages through `kb.list` ("Load more"); with one it shows `kb.search` hits and their snippets.
 */
export function KbList({
  project,
  projectParam,
  state,
  onStateChange,
  emptyAction,
  renderKind,
}: KbListProps) {
  const id = useId();
  const [input, setInput] = useState(state.q);
  const q = useDebouncedValue(input.trim(), KB_SEARCH_DEBOUNCE_MS);
  const searching = q.length > 0;

  const stateRef = useRef({ state, onStateChange });
  stateRef.current = { state, onStateChange };

  // The settled query goes into the address.
  useEffect(() => {
    const { state: current, onStateChange: change } = stateRef.current;
    if (q !== current.q) change({ ...current, q });
  }, [q]);

  // The address changed by itself (Back, a link): show its query.
  const settledRef = useRef(q);
  settledRef.current = q;
  useEffect(() => {
    if (state.q !== settledRef.current) setInput(state.q);
  }, [state.q]);

  const filter = { kind: state.kind, tag: state.tag };
  const list = useInfiniteQuery({
    ...kbListQueryOptions(project.id, filter),
    enabled: !searching,
  });
  const search = useQuery({
    ...kbSearchQueryOptions(project.id, q, state.kind),
    enabled: searching,
    placeholderData: keepPreviousData,
  });
  const tags = useQuery(kbTagsQueryOptions(project.id));

  const clearSearch = () => {
    setInput("");
    onStateChange({ ...state, q: "" });
  };

  const custom = !searching && state.tag === null ? renderKind?.[state.kind] : undefined;

  return (
    <section
      aria-label="Knowledge"
      aria-busy={(searching ? search.isPending : list.isPending) || undefined}
      className="overflow-hidden rounded-lg bg-card shadow-card"
    >
      <Tabs
        value={state.kind}
        onValueChange={(value) => onStateChange({ ...state, kind: value as KbFilter })}
        className="gap-0"
      >
        <div className="flex h-11 items-center border-divider border-b px-2">
          <ScrollArea orientation="horizontal" className="min-w-0 max-w-full">
            <TabsList aria-label="Filter by kind" className="justify-start">
              {KB_FILTERS.map((value) => {
                const Icon = value === "all" ? null : KIND_META[value].icon;
                return (
                  <TabsTrigger key={value} value={value} className="flex-none">
                    {Icon ? <Icon aria-hidden="true" className="max-sm:hidden" /> : null}
                    {filterLabel(value)}
                  </TabsTrigger>
                );
              })}
            </TabsList>
          </ScrollArea>
        </div>

        <div className="flex flex-col gap-2 border-divider border-b px-3.5 py-2.5 sm:flex-row sm:items-center">
          <div className="relative sm:w-64 sm:shrink-0">
            <SearchIcon
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              type="search"
              aria-label="Search knowledge"
              placeholder="Search titles, tags and text"
              value={input}
              maxLength={KB_SEARCH_QUERY_MAX_LENGTH}
              className="pl-8"
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape" && input) {
                  event.preventDefault();
                  clearSearch();
                }
              }}
            />
          </div>
          {searching ? (
            <p className="min-w-0 truncate text-small text-muted-foreground">
              Searching{" "}
              {state.kind === "all" ? "every kind" : filterLabel(state.kind).toLowerCase()}; tags
              apply to the list only.
            </p>
          ) : (
            <TagFilter
              tags={tags.data ?? []}
              selected={state.tag}
              onSelect={(tag) => onStateChange({ ...state, tag })}
            />
          )}
        </div>

        <TabsContent value={state.kind} className="min-h-[216px]" tabIndex={-1}>
          <p id={`${id}-status`} aria-live="polite" className="sr-only">
            {searching
              ? search.data
                ? `${search.data.length} ${search.data.length === 1 ? "match" : "matches"}`
                : ""
              : list.data
                ? `${list.data.pages.reduce((sum, page) => sum + page.items.length, 0)} entries`
                : ""}
          </p>
          {searching ? (
            <SearchResults query={search} q={q} projectParam={projectParam} onClear={clearSearch} />
          ) : custom ? (
            custom()
          ) : (
            <ListBody
              list={list}
              state={state}
              projectParam={projectParam}
              onClearTag={() => onStateChange({ ...state, tag: null })}
              emptyAction={emptyAction}
            />
          )}
        </TabsContent>
      </Tabs>
    </section>
  );
}

function TagFilter({
  tags,
  selected,
  onSelect,
}: {
  tags: { tag: string; count: number }[];
  selected: string | null;
  onSelect: (tag: string | null) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  if (tags.length === 0 && selected === null) return null;
  const visible = expanded ? tags : tags.slice(0, VISIBLE_TAGS);
  const shown =
    selected && !visible.some((item) => item.tag === selected)
      ? [{ tag: selected, count: 0 }, ...visible]
      : visible;

  return (
    <ScrollArea orientation="horizontal" className="min-w-0 flex-1 max-sm:-mx-3.5">
      <fieldset className="flex items-center gap-1.5 max-sm:px-3.5 sm:flex-wrap">
        <legend className="sr-only">Filter by tag</legend>
        <TagIcon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
        {shown.map(({ tag, count }) => {
          const active = tag === selected;
          return (
            <button
              key={tag}
              type="button"
              aria-pressed={active}
              onClick={() => onSelect(active ? null : tag)}
              className={cn(
                "pressable inline-flex h-6 shrink-0 items-center gap-1 rounded-full px-2 font-mono text-[11px] outline-none focus-visible:ring-2 focus-visible:ring-ring",
                active
                  ? "bg-accent-soft text-primary shadow-[0_0_0_1px_var(--ring)]"
                  : "bg-secondary text-text-2 shadow-[0_0_0_1px_var(--border)] hover:text-foreground",
              )}
            >
              #{tag}
              {count > 0 ? (
                <span className="text-[10px] text-muted-foreground tabular-nums">{count}</span>
              ) : null}
              {active ? <XIcon aria-hidden="true" className="size-3" /> : null}
            </button>
          );
        })}
        {tags.length > VISIBLE_TAGS ? (
          <Button
            variant="ghost"
            size="xs"
            className="shrink-0"
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? "Fewer tags" : `${tags.length - VISIBLE_TAGS} more`}
          </Button>
        ) : null}
      </fieldset>
    </ScrollArea>
  );
}

function ListBody({
  list,
  state,
  projectParam,
  onClearTag,
  emptyAction,
}: {
  list: UseInfiniteQueryResult<InfiniteData<CursorPage<KbEntry>, unknown>>;
  state: KbListState;
  projectParam: string;
  onClearTag: () => void;
  emptyAction?: (kind: KbFilter) => ReactNode;
}) {
  if (list.isPending) return <KbRowsSkeleton />;
  if (list.isError) {
    return (
      <ErrorState
        size="compact"
        title="Couldn't load the knowledge base"
        error={list.error}
        onRetry={() => void list.refetch()}
        retrying={list.isFetching}
      />
    );
  }

  const entries = list.data?.pages.flatMap((page) => page.items) ?? [];
  if (entries.length === 0) {
    if (state.tag !== null) {
      return (
        <EmptyState
          size="compact"
          icon={TagIcon}
          title={`Nothing tagged #${state.tag}`}
          description={
            state.kind === "all"
              ? "No entry carries this tag."
              : `No ${filterLabel(state.kind).toLowerCase()} carry this tag.`
          }
          action={
            <Button variant="outline" onClick={onClearTag}>
              Clear tag
            </Button>
          }
        />
      );
    }
    const empty = EMPTY_COPY[state.kind];
    return (
      <EmptyState
        size="compact"
        icon={empty.icon}
        title={empty.title}
        description={empty.description}
        action={emptyAction?.(state.kind)}
      />
    );
  }

  return (
    <>
      <ul aria-label={`${filterLabel(state.kind)} entries`} className="divide-y divide-divider">
        {entries.map((entry) => (
          <li key={entry.id}>
            <KbRow entry={entry} projectParam={projectParam} />
          </li>
        ))}
      </ul>
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

function SearchResults({
  query,
  q,
  projectParam,
  onClear,
}: {
  query: UseQueryResult<KbSearchHit[]>;
  q: string;
  projectParam: string;
  onClear: () => void;
}) {
  if (query.isPending) return <KbRowsSkeleton rows={3} />;
  if (query.isError) {
    return (
      <ErrorState
        size="compact"
        title="Couldn't search the knowledge base"
        error={query.error}
        onRetry={() => void query.refetch()}
        retrying={query.isFetching}
      />
    );
  }
  if (query.data.length === 0) {
    return (
      <EmptyState
        size="compact"
        icon={SearchXIcon}
        title={`No matches for “${q}”`}
        description="Try fewer words, or another kind."
        action={
          <Button variant="outline" onClick={onClear}>
            Clear search
          </Button>
        }
      />
    );
  }
  return (
    <>
      <ul aria-label="Search results" className="divide-y divide-divider">
        {query.data.map((hit) => (
          <li key={hit.entryId}>
            <KbHitRow hit={hit} projectParam={projectParam} />
          </li>
        ))}
      </ul>
      {query.data.length >= KB_SEARCH_MAX_LIMIT ? (
        <p className="border-divider border-t px-3.5 py-2.5 text-center text-small text-muted-foreground">
          Showing the best {KB_SEARCH_MAX_LIMIT} matches. Add words to narrow the search.
        </p>
      ) : null}
    </>
  );
}

const EMPTY_COPY: Record<KbFilter, { icon: LucideIcon; title: string; description: string }> = {
  all: {
    icon: KIND_META.note.icon,
    title: "Nothing saved yet",
    description:
      "Brainstorms, references, decisions and notes live here. The studio agent reads them when it writes.",
  },
  brainstorm: {
    icon: KIND_META.brainstorm.icon,
    title: "No brainstorms yet",
    description: "Catch rough ideas here before they turn into scripts.",
  },
  reference: {
    icon: KIND_META.reference.icon,
    title: "No references yet",
    description: "Save videos you liked and why, with a transcript, to learn from how they work.",
  },
  decision: {
    icon: KIND_META.decision.icon,
    title: "No decisions yet",
    description: "Record what you decided and why, so later scripts stay consistent.",
  },
  note: {
    icon: KIND_META.note.icon,
    title: "No notes yet",
    description: "Anything worth keeping that is not an idea, a reference or a decision.",
  },
  session_summary: {
    icon: KIND_META.session_summary.icon,
    title: "No session summaries yet",
    description: "A summary appears here when a producer session ends.",
  },
};
