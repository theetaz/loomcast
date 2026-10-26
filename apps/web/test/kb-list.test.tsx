import { act, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { publish } from "@/mocks/db";
import { listedEntry, mockKbEntry, updateKbEntry } from "@/mocks/kb";
import { at, kbSetup, recordRequests, WORKSPACE_SLUG } from "./support/kb";
import { fakeStream } from "./support/live";
import { renderApp } from "./support/render";

const KB_PATH = `/w/${WORKSPACE_SLUG}/kb`;

function renderKb(db: ReturnType<typeof kbSetup>["db"], path = KB_PATH) {
  const stream = fakeStream(db);
  const view = renderApp(path, db, [], { createEventSource: stream.factory });
  return { ...view, stream };
}

const rowTitles = (list: HTMLElement) =>
  within(list)
    .getAllByRole("link")
    .map((link) => link.textContent);

describe("knowledge list", () => {
  it("lists every entry newest first, with kind filters in the address", async () => {
    const { db } = kbSetup();
    const requests = recordRequests();
    const { user, router } = renderKb(db);

    const all = await screen.findByRole("list", { name: "All entries" });
    expect(rowTitles(all)).toEqual([
      expect.stringContaining("Hooks that open on the error"),
      expect.stringContaining("Recording checklist"),
      expect.stringContaining("Captions in the lower third"),
      expect.stringContaining("Instagram video by @fastrust"),
    ]);

    await user.click(screen.getByRole("tab", { name: /notes/i }));
    const notes = await screen.findByRole("list", { name: "Notes entries" });
    expect(rowTitles(notes)).toEqual([expect.stringContaining("Recording checklist")]);
    expect(router.state.location.search).toEqual({ kind: "note" });
    expect(
      requests.some(
        (request) => request.path.endsWith("/kb") && request.query.get("kinds") === "note",
      ),
    ).toBe(true);
  });

  it("filters by tag chip and clears it again", async () => {
    const { db } = kbSetup();
    const { user, router } = renderKb(db);

    const tags = await screen.findByRole("group", { name: "Filter by tag" });
    await user.click(await within(tags).findByRole("button", { name: /#hooks/ }));

    await waitFor(() => expect(router.state.location.search).toEqual({ tag: "hooks" }));
    const list = await screen.findByRole("list", { name: "All entries" });
    await waitFor(() => expect(within(list).getAllByRole("link")).toHaveLength(2));
    expect(within(tags).getByRole("button", { name: /#hooks/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await user.click(within(tags).getByRole("button", { name: /#hooks/ }));
    await waitFor(() => expect(router.state.location.search).toEqual({}));
  });

  it("switches to search after the debounce and back to the list when cleared", async () => {
    const { db, workspace } = kbSetup();
    const requests = recordRequests();
    const { user, router } = renderKb(db);
    await screen.findByRole("list", { name: "All entries" });

    await user.click(screen.getByRole("tab", { name: /brainstorms/i }));
    await user.type(screen.getByRole("searchbox", { name: "Search knowledge" }), "error");

    const results = await screen.findByRole("list", { name: "Search results" });
    expect(within(results).getByText("Hooks that open on the error")).toBeInTheDocument();
    const mark = within(results).getAllByText("error", { selector: "mark" })[0];
    expect(mark?.tagName).toBe("MARK");

    const searches = requests.filter((request) => request.path === "/api/kb/search");
    // Typing five letters searched once, with the settled query.
    expect(searches.map((request) => request.query.get("q"))).toEqual(["error"]);
    expect(searches[0]?.query.get("workspaceId")).toBe(workspace.id);
    expect(searches[0]?.query.get("kinds")).toBe("brainstorm");
    expect(router.state.location.search).toEqual({ kind: "brainstorm", q: "error" });

    await user.keyboard("{Escape}");
    expect(await screen.findByRole("list", { name: "Brainstorms entries" })).toBeInTheDocument();
    await waitFor(() => expect(router.state.location.search).toEqual({ kind: "brainstorm" }));
  });

  it("shows no-match and per-kind empty states", async () => {
    const { db } = kbSetup();
    db.kbEntries = db.kbEntries.filter((entry) => entry.kind !== "reference");
    const { user } = renderKb(db, `${KB_PATH}?kind=reference`);

    expect(await screen.findByText("No references yet")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Add reference" })).toHaveAttribute(
      "href",
      `/w/${WORKSPACE_SLUG}/kb/new?kind=reference`,
    );

    await user.click(screen.getByRole("tab", { name: /sessions/i }));
    expect(await screen.findByText("No session summaries yet")).toBeInTheDocument();

    await user.type(screen.getByRole("searchbox", { name: "Search knowledge" }), "zebra");
    expect(await screen.findByText("No matches for “zebra”")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear search" }));
    expect(await screen.findByText("No session summaries yet")).toBeInTheDocument();
  });

  it("pages with Load more", async () => {
    const { db } = kbSetup((workspace) =>
      Array.from({ length: 52 }, (_, index) =>
        mockKbEntry({
          workspaceId: workspace.id,
          kind: "note",
          title: `Old note ${index + 1}`,
          createdAt: at(-index - 1),
          updatedAt: at(-index - 1),
        }),
      ),
    );
    const { user } = renderKb(db);

    const list = await screen.findByRole("list", { name: "All entries" });
    expect(within(list).getAllByRole("link")).toHaveLength(50);
    await user.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(within(list).getAllByRole("link")).toHaveLength(56));
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
  });

  it("applies live created, updated and deleted events", async () => {
    const { db, workspace, note } = kbSetup();
    renderKb(db);
    const list = await screen.findByRole("list", { name: "All entries" });

    const created = mockKbEntry({
      workspaceId: workspace.id,
      kind: "brainstorm",
      title: "Captured by a producer session",
      createdVia: "producer",
    });
    act(() => {
      db.kbEntries.push(created);
      publish(db, { type: "kb.entry.created", payload: { entry: listedEntry(created) } });
    });
    await waitFor(() =>
      expect(rowTitles(list)[0]).toEqual(expect.stringContaining("Captured by a producer session")),
    );

    act(() => {
      updateKbEntry(db, note.id, (entry) => {
        entry.title = "Recording checklist v2";
      });
    });
    expect(await within(list).findByText("Recording checklist v2")).toBeInTheDocument();

    act(() => {
      db.kbEntries = db.kbEntries.filter((entry) => entry.id !== created.id);
      publish(db, {
        type: "kb.entry.deleted",
        payload: { entryId: created.id, workspaceId: workspace.id },
      });
    });
    await waitFor(() =>
      expect(within(list).queryByText("Captured by a producer session")).not.toBeInTheDocument(),
    );
  });
});
