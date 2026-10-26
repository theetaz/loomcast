import { act, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LIBRARY_VIEW_KEY } from "@/features/library/view-preference";
import { preloadPalette } from "@/features/palette/load";
import { mockContentItem, updateContentItem } from "@/mocks/content";
import { publish } from "@/mocks/db";
import { recordRequests } from "./support/kb";
import { librarySetup } from "./support/library";
import { fakeStream } from "./support/live";
import { renderApp } from "./support/render";

const LIBRARY = "/w/rust-in-60-seconds/library";

function renderLibrary(db: ReturnType<typeof librarySetup>["db"], path = LIBRARY) {
  const stream = fakeStream(db);
  const view = renderApp(path, db, [], { createEventSource: stream.factory });
  return { ...view, stream };
}

async function table() {
  const caption = await screen.findByText(/^Videos, sorted by/);
  return caption.closest("table") as HTMLTableElement;
}

const rowTitles = (element: HTMLElement) =>
  within(element)
    .getAllByRole("row")
    .slice(1)
    .map((row) => within(row).getAllByRole("cell")[0]?.textContent);

function rowOf(title: string) {
  return screen.getByRole("link", { name: title }).closest("tr") as HTMLTableRowElement;
}

describe("library table", () => {
  it("lists the workspace's items but the archived, newest change first", async () => {
    const { db, items } = librarySetup();
    renderLibrary(db);
    const grid = await table();
    await waitFor(() =>
      expect(rowTitles(grid)).toEqual([
        items.borrow.title,
        items.question.title,
        items.lifetimes.title,
        items.moves.title,
      ]),
    );
    // The other workspace's items never show here.
    expect(screen.queryByRole("link", { name: items.handoffs.title })).not.toBeInTheDocument();
    const row = within(rowOf(items.moves.title));
    expect(row.getByText("In review")).toHaveAttribute("data-tone", "amber");
    expect(row.getByText("v3")).toBeInTheDocument();
    expect(row.getByText("1:05")).toBeInTheDocument();
    expect(await row.findByText("Ownership basics")).toBeInTheDocument();
    expect(screen.getByText("4 videos")).toBeInTheDocument();
  });

  it("reads filters from the address and sends them to content.list", async () => {
    const { db, items, series, rust } = librarySetup();
    const requests = recordRequests();
    renderLibrary(
      db,
      `${LIBRARY}?states=review,script&series=${series.ownership.id}&from=2026-10-10&to=2026-10-31&q=moves`,
    );
    const grid = await table();
    await waitFor(() => expect(rowTitles(grid)).toEqual([items.moves.title]));

    const list = requests.find((request) => request.path === "/api/content");
    expect(list?.query.get("states")).toBe("script,review");
    expect(list?.query.get("seriesId")).toBe(series.ownership.id);
    expect(list?.query.get("q")).toBe("moves");
    expect(list?.query.get("targetFrom")).toBe(new Date(2026, 9, 10).toISOString());
    expect(list?.query.get("workspaceId")).toBe(rust.id);
    expect(screen.getByRole("searchbox", { name: "Search titles and pitches" })).toHaveValue(
      "moves",
    );
    expect(screen.getByRole("button", { name: "State: 2 states" })).toBeInTheDocument();
    expect(screen.getByLabelText("Target from")).toHaveValue("2026-10-10");
  });

  it("writes filter and sort changes into the address", async () => {
    const { db, items } = librarySetup();
    const { user, router } = renderLibrary(db);
    await table();

    await user.click(screen.getByRole("button", { name: "State: Any state" }));
    await user.click(await screen.findByRole("menuitemcheckbox", { name: "Idea" }));
    await user.click(screen.getByRole("menuitemcheckbox", { name: "In review" }));
    await waitFor(() => expect(router.state.location.search).toEqual({ states: "idea,review" }));
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(rowTitles(screen.getByRole("table"))).toEqual([items.borrow.title, items.moves.title]),
    );

    await user.type(screen.getByRole("searchbox", { name: "Search titles and pitches" }), "loop");
    await waitFor(() =>
      expect(router.state.location.search).toEqual({ states: "idea,review", q: "loop" }),
    );
    await waitFor(() => expect(rowTitles(screen.getByRole("table"))).toEqual([items.borrow.title]));

    await user.click(screen.getByRole("button", { name: "Title" }));
    await waitFor(() =>
      expect(router.state.location.search).toEqual({
        states: "idea,review",
        q: "loop",
        sort: "title",
      }),
    );
    expect(screen.getByRole("columnheader", { name: /Title/ })).toHaveAttribute(
      "aria-sort",
      "ascending",
    );

    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    await waitFor(() => expect(router.state.location.search).toEqual({ sort: "title" }));
  });

  it("drops invalid params and shows the filtered empty state", async () => {
    const { db } = librarySetup();
    const { user, router } = renderLibrary(db, `${LIBRARY}?states=drafting&sort=loudness&q=zebra`);
    expect(await screen.findByText("No videos match these filters")).toBeInTheDocument();
    expect(router.state.location.search).toEqual({ q: "zebra" });
    // The filter bar and the empty state both offer it.
    const clear = screen.getAllByRole("button", { name: "Clear filters" });
    expect(clear).toHaveLength(2);
    await user.click(clear[1] as HTMLElement);
    await table();
    await waitFor(() => expect(router.state.location.search).toEqual({}));
  });

  it("moves between rows with the arrow keys and opens one with Enter", async () => {
    const { db, items } = librarySetup();
    const { user, router } = renderLibrary(db);
    await table();
    const first = await screen.findByRole("link", { name: items.borrow.title });
    expect(first).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("link", { name: items.question.title })).toHaveAttribute(
      "tabindex",
      "-1",
    );

    act(() => first.focus());
    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(screen.getByRole("link", { name: items.lifetimes.title })).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(screen.getByRole("link", { name: items.question.title })).toHaveFocus();
    await user.keyboard("{End}");
    expect(screen.getByRole("link", { name: items.moves.title })).toHaveFocus();
    await user.keyboard("{Home}");
    expect(first).toHaveFocus();
    expect(screen.getByRole("link", { name: items.borrow.title })).toHaveAttribute("tabindex", "0");

    await user.keyboard("{ArrowDown}{Enter}");
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(
        `/w/rust-in-60-seconds/content/${items.question.id}`,
      ),
    );
    expect(
      await screen.findByRole("heading", { name: items.question.title, level: 1 }),
    ).toBeInTheDocument();
  });

  it("opens the old Content tab address as the workspace's library", async () => {
    const { db, items, rust } = librarySetup();
    const requests = recordRequests();
    const { router } = renderLibrary(db, `/workspaces/${rust.slug}/content`);
    const grid = await table();
    await waitFor(() => expect(router.state.location.pathname).toBe(`/w/${rust.slug}/library`));
    await waitFor(() =>
      expect(rowTitles(grid)).toEqual([
        items.borrow.title,
        items.question.title,
        items.lifetimes.title,
        items.moves.title,
      ]),
    );
    expect(
      requests.find((request) => request.path === "/api/content")?.query.get("workspaceId"),
    ).toBe(rust.id);
  });
});

describe("live updates", () => {
  it("patches rows from content.item events", async () => {
    const { db, items, rust } = librarySetup();
    renderLibrary(db, `${LIBRARY}?states=idea,script`);
    const grid = await table();
    await waitFor(() =>
      expect(rowTitles(grid)).toEqual([items.borrow.title, items.question.title]),
    );

    // A new idea from another writer appears at the top.
    const created = mockContentItem({ workspaceId: rust.id, title: "Iterators are lazy" });
    db.contentItems.push(created.item);
    act(() => publish(db, { type: "content.item.created", payload: { item: created.item } }));
    await waitFor(() => expect(rowTitles(grid)[0]).toBe("Iterators are lazy"));

    // An idea gets its script: it changes in place.
    act(() => {
      updateContentItem(db, items.borrow.id, (item) => {
        item.state = "script";
        item.versionNo = 2;
      });
    });
    await waitFor(() =>
      expect(within(rowOf(items.borrow.title)).getByText("Script")).toBeVisible(),
    );
    expect(within(rowOf(items.borrow.title)).getByText("v2")).toBeInTheDocument();

    // The script moves on to storyboard: it leaves this filtered list.
    act(() => {
      updateContentItem(db, items.question.id, (item) => {
        item.state = "storyboard";
      });
    });
    await waitFor(() =>
      expect(screen.queryByRole("link", { name: items.question.title })).not.toBeInTheDocument(),
    );
    // Rows stay newest change first: the edited idea is now the newest.
    expect(rowTitles(grid)).toEqual([items.borrow.title, "Iterators are lazy"]);
  });
});

describe("pipeline board", () => {
  it("groups items into state columns and remembers the view", async () => {
    const { db, items } = librarySetup();
    const { user, unmount } = renderLibrary(db);
    await table();

    await user.click(screen.getByRole("tab", { name: "Board" }));
    const board = await screen.findByRole("region", { name: "Pipeline board" });
    const columns = within(board)
      .getAllByRole("listitem")
      .filter((item) => item.dataset.state);
    expect(columns.map((column) => column.dataset.state)).toEqual([
      "idea",
      "script",
      "storyboard",
      "voice",
      "render",
      "review",
      "approved",
      "scheduled",
      "published",
    ]);
    const idea = within(board).getByRole("listitem", { name: "Idea, 1 item" });
    expect(
      within(idea)
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual([items.borrow.title]);
    expect(within(board).getByRole("listitem", { name: "Voice, 0 items" })).toHaveTextContent(
      "Nothing here",
    );
    expect(window.localStorage.getItem(LIBRARY_VIEW_KEY)).toBe("board");

    unmount();
    renderLibrary(db, `${LIBRARY}?states=review,archived`);
    const again = await screen.findByRole("region", { name: "Pipeline board" });
    await waitFor(() =>
      expect(
        within(again)
          .getAllByRole("listitem")
          .filter((item) => item.dataset.state)
          .map((column) => column.dataset.state),
      ).toEqual(["review", "archived"]),
    );
    expect(within(again).getByRole("link", { name: items.archived.title })).toBeInTheDocument();
  });
});

describe("quick actions", () => {
  it("produces an idea through review and offers only allowed actions", async () => {
    const { db, items } = librarySetup();
    const requests = recordRequests();
    const { user } = renderLibrary(db);
    await table();

    await user.click(
      await screen.findByRole("button", { name: `Actions for ${items.moves.title}` }),
    );
    expect(await screen.findByRole("menuitem", { name: "Produce through review" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await user.keyboard("{Escape}");

    await user.click(screen.getByRole("button", { name: `Actions for ${items.borrow.title}` }));
    await user.click(await screen.findByRole("menuitem", { name: "Produce through review" }));
    expect(await screen.findByText("Production started")).toBeInTheDocument();
    const action = requests.find((request) => request.path.endsWith("/actions"));
    expect(action?.path).toBe(`/api/content/${items.borrow.id}/actions`);
    expect(action?.body).toEqual({ action: "produce", through: "review" });
  });

  it("archives after a confirmation and drops the row", async () => {
    const { db, items } = librarySetup();
    const { user } = renderLibrary(db);
    await table();

    await user.click(
      await screen.findByRole("button", { name: `Actions for ${items.question.title}` }),
    );
    await user.click(await screen.findByRole("menuitem", { name: "Archive" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent(`Archive ${items.question.title}?`);
    await user.click(within(dialog).getByRole("button", { name: "Archive" }));

    await waitFor(() =>
      expect(screen.queryByRole("link", { name: items.question.title })).not.toBeInTheDocument(),
    );
    expect(db.contentItems.find((item) => item.id === items.question.id)?.state).toBe("archived");
  });
});

describe("new idea", () => {
  it("adds an idea to the open workspace and the chosen series", async () => {
    const { db, rust, series } = librarySetup();
    const requests = recordRequests();
    const { user } = renderLibrary(db);
    await table();

    await user.click(screen.getByRole("button", { name: "New idea" }));
    const dialog = await screen.findByRole("dialog", { name: "New idea" });
    await user.click(within(dialog).getByRole("button", { name: "Add idea" }));
    expect(await within(dialog).findByText("Give the idea a title.")).toBeInTheDocument();

    await user.type(within(dialog).getByLabelText("Title"), "Traits as contracts");
    await user.type(within(dialog).getByLabelText(/Pitch/), "One trait, three impls.");
    // Inside a workspace the idea always goes into it: there is nothing to pick.
    expect(within(dialog).queryByRole("combobox", { name: /Workspace/ })).not.toBeInTheDocument();

    // The series select stays disabled until the workspace's series have loaded.
    const seriesSelect = within(dialog).getByRole("combobox", { name: /Series/ });
    await waitFor(() => expect(seriesSelect).toBeEnabled());
    await user.click(seriesSelect);
    await user.click(await screen.findByRole("option", { name: series.errors.name }));
    await user.click(within(dialog).getByRole("button", { name: "Add idea" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(await screen.findByRole("link", { name: "Traits as contracts" })).toBeInTheDocument();
    const create = requests.find((request) => request.method === "POST");
    expect(create?.path).toBe(`/api/workspaces/${rust.id}/content`);
    expect(create?.body).toEqual({
      title: "Traits as contracts",
      pitch: "One trait, three impls.",
      seriesId: series.errors.id,
    });
  });
});

describe("palette", () => {
  it("finds the workspace's videos by title and opens them", async () => {
    await preloadPalette();
    const { db, items, rust } = librarySetup();
    const requests = recordRequests();
    const { user, router } = renderLibrary(db);
    await table();

    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }),
      );
    });
    const palette = await screen.findByRole("dialog", { name: "Search or jump to" });
    await user.keyboard("borrow");
    const option = await within(palette).findByRole("option", { name: /Why the borrow checker/ });
    expect(option).toHaveTextContent("Idea");
    const searches = requests.filter(
      (request) => request.path === "/api/content" && request.query.get("q"),
    );
    expect(searches).toHaveLength(1);
    expect(searches[0]?.query.get("workspaceId")).toBe(rust.id);

    await user.click(option);
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/w/${rust.slug}/content/${items.borrow.id}`),
    );
  });
});
