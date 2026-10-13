import { type ContentItem, type ContentItemDetail, PIPELINE_STATES } from "@loomcast/contracts";
import { STATUS_STYLES, statusStyle } from "@loomcast/ui/components/StatusPill";
import { describe, expect, it } from "vitest";
import { formatDuration } from "@/features/library/format";
import { BOARD_STATES, groupByState, nextSort, sortItems } from "@/features/library/items";
import {
  type ContentPages,
  contentKeys,
  matchesFilter,
  upsertContentItem,
} from "@/features/library/queries";
import {
  contentListQuery,
  endOfDay,
  filterFromSearch,
  type LibraryFilter,
  LibrarySearchSchema,
  parseStates,
  searchFromFilter,
  startOfDay,
} from "@/features/library/search";
import { createQueryClient } from "@/lib/query-client";
import { librarySetup } from "./support/library";

const NO_FILTER: LibraryFilter = {
  projectId: null,
  states: [],
  seriesId: null,
  from: null,
  to: null,
  q: "",
};

describe("pipeline status pill", () => {
  it("has exactly one style per pipeline state", () => {
    expect(Object.keys(STATUS_STYLES.pipeline).sort()).toEqual([...PIPELINE_STATES].sort());
  });

  it("maps the states to the planned tones", () => {
    const tones = Object.fromEntries(
      PIPELINE_STATES.map((state) => [state, statusStyle("pipeline", state).tone]),
    );
    expect(tones).toEqual({
      idea: "gray",
      script: "amber",
      storyboard: "amber",
      voice: "violet",
      render: "violet",
      review: "amber",
      approved: "green",
      scheduled: "blue",
      published: "green",
      archived: "gray",
    });
    expect(statusStyle("pipeline", "review").label).toBe("In review");
  });
});

describe("library search params", () => {
  it("keeps valid filters and normalises states into pipeline order", () => {
    const series = librarySetup().series.ownership.id;
    expect(
      LibrarySearchSchema.parse({
        states: "voice,idea,voice",
        series,
        from: "2026-10-01",
        to: "2026-10-31",
        q: "borrow",
        sort: "-target",
      }),
    ).toEqual({
      states: "idea,voice",
      series,
      from: "2026-10-01",
      to: "2026-10-31",
      q: "borrow",
      sort: "-target",
    });
  });

  it("drops invalid values instead of failing", () => {
    expect(
      LibrarySearchSchema.parse({
        states: "drafting,failed",
        series: "not-an-id",
        from: "2026-02-30",
        to: "tomorrow",
        q: "   ",
        sort: "loudness",
      }),
    ).toEqual({});
  });

  it("keeps only the start of a range that ends before it starts", () => {
    expect(LibrarySearchSchema.parse({ from: "2026-10-10", to: "2026-10-01" })).toEqual({
      from: "2026-10-10",
    });
  });

  it("reads a numeric search the router parsed as JSON", () => {
    expect(LibrarySearchSchema.parse({ q: 2026 })).toEqual({ q: "2026" });
  });

  it("round-trips a filter and leaves defaults out of the address", () => {
    const filter: LibraryFilter = {
      ...NO_FILTER,
      states: parseStates("review,script"),
      q: "loop",
      from: "2026-10-01",
    };
    const search = searchFromFilter(filter, "-updated");
    expect(search).toEqual({ states: "script,review", q: "loop", from: "2026-10-01" });
    expect(filterFromSearch(search, null)).toEqual(filter);
    expect(searchFromFilter(NO_FILTER, "-updated")).toEqual({});
    expect(searchFromFilter(NO_FILTER, "title")).toEqual({ sort: "title" });
  });

  it("builds the content.list query with comma-separated states and day bounds", () => {
    expect(
      contentListQuery({
        projectId: "p",
        states: ["script", "voice"],
        seriesId: "s",
        from: "2026-10-01",
        to: "2026-10-31",
        q: "loop",
      }),
    ).toEqual({
      projectId: "p",
      states: "script,voice",
      seriesId: "s",
      q: "loop",
      targetFrom: startOfDay("2026-10-01"),
      targetTo: endOfDay("2026-10-31"),
    });
    expect(Date.parse(endOfDay("2026-10-31")) - Date.parse(startOfDay("2026-10-31"))).toBe(
      24 * 60 * 60_000 - 1,
    );
    expect(contentListQuery(NO_FILTER)).toEqual({});
  });
});

describe("board grouping", () => {
  it("puts every item in its state's column, in pipeline order without the archive", () => {
    const { items } = librarySetup();
    const columns = groupByState(Object.values(items));
    expect(columns.map((column) => column.state)).toEqual(BOARD_STATES);
    expect(BOARD_STATES).not.toContain("archived");
    const titles = Object.fromEntries(
      columns.map((column) => [column.state, column.items.map((item) => item.title)]),
    );
    expect(titles.idea).toEqual([items.borrow.title, items.handoffs.title]);
    expect(titles.review).toEqual([items.moves.title]);
    expect(titles.voice).toEqual([]);
    expect(columns.flatMap((column) => column.items)).not.toContainEqual(items.archived);
  });

  it("shows only the filtered states, in pipeline order", () => {
    const { items } = librarySetup();
    const columns = groupByState(Object.values(items), ["archived", "idea"]);
    expect(columns.map((column) => column.state)).toEqual(["idea", "archived"]);
    expect(columns[1]?.items).toEqual([items.archived]);
  });
});

describe("sorting", () => {
  const { items, series } = librarySetup();
  const list = Object.values(items);
  const names = new Map(Object.values(series).map((entry) => [entry.id, entry.name]));
  const seriesName = (id: string) => names.get(id);
  const titles = (sorted: ContentItem[]) => sorted.map((item) => item.title);

  it("sorts targets soonest first with undated items last in both directions", () => {
    const ascending = titles(sortItems(list, "target"));
    expect(ascending.slice(0, 4)).toEqual([
      items.published.title,
      items.moves.title,
      items.lifetimes.title,
      items.question.title,
    ]);
    const descending = titles(sortItems(list, "-target"));
    expect(descending.slice(0, 4)).toEqual([
      items.question.title,
      items.lifetimes.title,
      items.moves.title,
      items.published.title,
    ]);
    expect(descending.slice(4)).toEqual(ascending.slice(4));
  });

  it("sorts by state in pipeline order and by series name", () => {
    expect(sortItems(list, "state")[0]?.state).toBe("idea");
    expect(sortItems(list, "-state")[0]?.state).toBe("archived");
    expect(sortItems(list, "series", seriesName)[0]?.seriesId).toBe(series.patterns.id);
  });

  it("starts each column in its natural direction and flips on a second choice", () => {
    expect(nextSort("-updated", "title")).toBe("title");
    expect(nextSort("title", "title")).toBe("-title");
    expect(nextSort("-title", "title")).toBe("title");
    expect(nextSort("title", "updated")).toBe("-updated");
    expect(nextSort("title", "target")).toBe("target");
  });

  it("formats lengths as minutes and seconds", () => {
    expect(formatDuration(42_000)).toBe("0:42");
    expect(formatDuration(65_400)).toBe("1:05");
  });
});

describe("live patching", () => {
  function seed(filter: LibraryFilter, list: ContentItem[]) {
    const queryClient = createQueryClient();
    const data: ContentPages = {
      pages: [{ items: list, nextCursor: null }],
      pageParams: [undefined],
    };
    queryClient.setQueryData(contentKeys.list(filter), data);
    const read = () =>
      queryClient
        .getQueryData<ContentPages>(contentKeys.list(filter))
        ?.pages.flatMap((page) => page.items.map((item) => item.title));
    return { queryClient, read };
  }

  it("decides membership from project, state, series and target range", () => {
    const { items, rust, series } = librarySetup();
    expect(matchesFilter(items.borrow, NO_FILTER)).toBe(true);
    expect(matchesFilter(items.archived, NO_FILTER)).toBe(false);
    expect(matchesFilter(items.archived, { ...NO_FILTER, states: ["archived"] })).toBe(true);
    expect(matchesFilter(items.handoffs, { ...NO_FILTER, projectId: rust.id })).toBe(false);
    expect(matchesFilter(items.question, { ...NO_FILTER, seriesId: series.ownership.id })).toBe(
      false,
    );
    expect(matchesFilter(items.borrow, { ...NO_FILTER, from: "2026-10-01" })).toBe(false);
    expect(matchesFilter(items.moves, { ...NO_FILTER, from: "2026-10-15", to: "2026-10-17" })).toBe(
      true,
    );
    expect(matchesFilter(items.borrow, { ...NO_FILTER, q: "borrow" })).toBeNull();
  });

  it("replaces, drops and inserts items in every loaded list", () => {
    const { items } = librarySetup();
    const reviewOnly = { ...NO_FILTER, states: ["review" as const] };
    const { queryClient } = seed(NO_FILTER, [items.borrow, items.question]);
    queryClient.setQueryData<ContentPages>(contentKeys.list(reviewOnly), {
      pages: [{ items: [items.moves], nextCursor: null }],
      pageParams: [undefined],
    });
    const read = (filter: LibraryFilter) =>
      queryClient
        .getQueryData<ContentPages>(contentKeys.list(filter))
        ?.pages.flatMap((page) => page.items.map((item) => `${item.title}:${item.state}`));

    // The question goes to review: it changes in place in one list and joins the other.
    const inReview = {
      ...items.question,
      state: "review" as const,
      updatedAt: "2026-10-01T12:00:00.000Z",
    };
    upsertContentItem(queryClient, inReview);
    expect(read(NO_FILTER)).toEqual([
      `${items.borrow.title}:idea`,
      `${items.question.title}:review`,
    ]);
    expect(read(reviewOnly)).toEqual([
      `${items.question.title}:review`,
      `${items.moves.title}:review`,
    ]);

    // Moves is approved: it leaves the review list and, newest, tops the unfiltered one.
    upsertContentItem(queryClient, {
      ...items.moves,
      state: "approved",
      updatedAt: "2026-10-01T12:01:00.000Z",
    });
    expect(read(reviewOnly)).toEqual([`${items.question.title}:review`]);
    expect(read(NO_FILTER)?.[0]).toBe(`${items.moves.title}:approved`);

    // An archived item leaves the default list.
    upsertContentItem(queryClient, {
      ...items.borrow,
      state: "archived",
      updatedAt: "2026-10-01T12:02:00.000Z",
    });
    expect(read(NO_FILTER)).toEqual([
      `${items.moves.title}:approved`,
      `${items.question.title}:review`,
    ]);
  });

  it("ignores an event older than the cached item", () => {
    const { items } = librarySetup();
    const { queryClient, read } = seed(NO_FILTER, [items.borrow]);
    upsertContentItem(queryClient, {
      ...items.borrow,
      title: "Stale title",
      updatedAt: "2020-01-01T00:00:00.000Z",
    });
    expect(read()).toEqual([items.borrow.title]);
  });

  it("keeps an item page stale until it has loaded the item's new current version", () => {
    const { items } = librarySetup();
    const queryClient = createQueryClient();
    const key = contentKeys.detail(items.borrow.id);
    queryClient.setQueryData<ContentItemDetail>(key, {
      item: items.borrow,
      currentVersion: { id: items.borrow.currentVersionId } as ContentItemDetail["currentVersion"],
      versions: [],
      activeJob: null,
    });
    // A job writes a new version, then autopilot moves the item on that same version, while
    // the item page is closed: the second event must not make the old version look current.
    const currentVersionId = crypto.randomUUID();
    upsertContentItem(queryClient, {
      ...items.borrow,
      currentVersionId,
      state: "render",
      updatedAt: "2026-10-01T12:00:00.000Z",
    });
    upsertContentItem(queryClient, {
      ...items.borrow,
      currentVersionId,
      state: "review",
      updatedAt: "2026-10-01T12:00:01.000Z",
    });
    expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryData<ContentItemDetail>(key)?.item.state).toBe("review");
  });

  it("refetches a searched list instead of guessing whether a new item matches", async () => {
    const { items } = librarySetup();
    const searched = { ...NO_FILTER, q: "loop" };
    const { queryClient, read } = seed(searched, []);
    upsertContentItem(queryClient, items.borrow);
    expect(read()).toEqual([]);
    expect(queryClient.getQueryState(contentKeys.list(searched))?.isInvalidated).toBe(true);
  });
});
