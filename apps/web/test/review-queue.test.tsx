import type { ContentItem } from "@loomcast/contracts";
import { act, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { deadlineOf } from "@/features/review-queue/deadline";
import { compareQueue } from "@/features/review-queue/queries";
import { mockContentItem, updateContentItem } from "@/mocks/content";
import { recordRequests } from "./support/kb";
import { at, librarySetup } from "./support/library";
import { fakeStream } from "./support/live";
import { renderApp } from "./support/render";

/** The library setup plus three more items in review, spread over projects and dates. */
function queueSetup() {
  const setup = librarySetup();
  const { db, rust, agents, series } = setup;
  const add = (overrides: Partial<ContentItem> & Pick<ContentItem, "projectId" | "title">) => {
    const { item, versions } = mockContentItem({ state: "review", versionNo: 5, ...overrides });
    db.contentItems.push(item);
    db.contentVersions.push(...versions);
    return item;
  };
  const undatedOld = add({
    projectId: rust.id,
    title: "Undated, waiting longest",
    seriesId: series.errors.id,
    updatedAt: at(1),
  });
  const undatedNew = add({ projectId: agents.id, title: "Undated, newer", updatedAt: at(50) });
  const soonest = add({
    projectId: agents.id,
    title: "Due first",
    seriesId: series.patterns.id,
    targetAt: "2026-10-15T09:00:00.000Z",
    updatedAt: at(40),
  });
  // `moves` (rust, 2026-10-16) comes from the library setup.
  return { ...setup, queue: { soonest, moves: setup.items.moves, undatedOld, undatedNew } };
}

function rowTitles() {
  const list = screen.getByRole("list", { name: "Videos in review" });
  return within(list)
    .getAllByRole("link")
    .map((link) => link.querySelector(".truncate")?.textContent);
}

describe("review queue", () => {
  it("lists items in review, nearest date first and undated ones last", async () => {
    const { db, queue, rust } = queueSetup();
    renderApp("/review", db);
    await screen.findByRole("list", { name: "Videos in review" }, { timeout: 5000 });
    expect(rowTitles()).toEqual([
      queue.soonest.title,
      queue.moves.title,
      queue.undatedOld.title,
      queue.undatedNew.title,
    ]);
    expect(screen.getByText("4 videos")).toBeInTheDocument();

    const moves = screen.getByRole("link", { name: new RegExp(queue.moves.title) });
    expect(await within(moves).findByText(`${rust.name} · Ownership basics`)).toBeInTheDocument();
    expect(within(moves).getByText("v3")).toBeInTheDocument();
    expect(within(moves).getByText("1:05")).toBeInTheDocument();
    const undated = screen.getByRole("link", { name: new RegExp(queue.undatedNew.title) });
    expect(within(undated).getByText("No date").closest("[data-tone]")).toHaveAttribute(
      "data-tone",
      "gray",
    );
    // Posters come from presigned URLs.
    await waitFor(() => expect(moves.querySelector("img")).toHaveAttribute("src"));
    expect(moves.querySelector("img")?.getAttribute("src")).toContain(
      `/mock-media/${queue.moves.posterAssetId}`,
    );
  });

  it("moves with j and k and opens the focused item with Enter", async () => {
    const { db, queue } = queueSetup();
    const { user, router } = renderApp("/review", db);
    await screen.findByRole("list", { name: "Videos in review" }, { timeout: 5000 });
    const link = (item: ContentItem) => screen.getByRole("link", { name: new RegExp(item.title) });

    await user.keyboard("j");
    expect(link(queue.soonest)).toHaveFocus();
    await user.keyboard("jj");
    expect(link(queue.undatedOld)).toHaveFocus();
    await user.keyboard("k");
    expect(link(queue.moves)).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(link(queue.undatedOld)).toHaveFocus();
    await user.keyboard("{End}");
    expect(link(queue.undatedNew)).toHaveFocus();
    await user.keyboard("j");
    expect(link(queue.undatedNew)).toHaveFocus();
    expect(link(queue.undatedNew)).toHaveAttribute("tabindex", "0");
    expect(link(queue.soonest)).toHaveAttribute("tabindex", "-1");

    await user.keyboard("{Home}{Enter}");
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/content/${queue.soonest.id}`),
    );
  });

  it("ignores j and k while typing in a field", async () => {
    const { db } = queueSetup();
    const { user } = renderApp("/review", db);
    await screen.findByRole("list", { name: "Videos in review" }, { timeout: 5000 });
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();
    await user.keyboard("j");
    expect(input).toHaveFocus();
    expect(input).toHaveValue("j");
    input.remove();
  });

  it("narrows to one project from the address", async () => {
    const { db, queue, agents } = queueSetup();
    const requests = recordRequests();
    renderApp(`/review?project=${agents.id}`, db);
    await screen.findByRole("list", { name: "Videos in review" }, { timeout: 5000 });
    expect(rowTitles()).toEqual([queue.soonest.title, queue.undatedNew.title]);
    const call = requests.find((request) => request.path === "/api/reviews/queue");
    expect(call?.query.get("projectId")).toBe(agents.id);
  });

  it("follows items into and out of review as they change", async () => {
    const { db, queue, items } = queueSetup();
    const stream = fakeStream(db);
    renderApp("/review", db, [], { createEventSource: stream.factory });
    await screen.findByRole("list", { name: "Videos in review" }, { timeout: 5000 });

    act(() => {
      updateContentItem(db, queue.moves.id, (item) => {
        item.state = "approved";
      });
    });
    await waitFor(() => expect(rowTitles()).not.toContain(queue.moves.title));

    act(() => {
      updateContentItem(db, items.lifetimes.id, (item) => {
        item.state = "review";
      });
    });
    // Lifetimes targets 2026-10-18: after "Due first", before the undated items.
    await waitFor(() =>
      expect(rowTitles()).toEqual([
        queue.soonest.title,
        items.lifetimes.title,
        queue.undatedOld.title,
        queue.undatedNew.title,
      ]),
    );
  });

  it("shows an empty state when nothing waits", async () => {
    const { db } = librarySetup();
    db.contentItems = db.contentItems.filter((item) => item.state !== "review");
    renderApp("/review", db);
    expect(await screen.findByText("Nothing to review", {}, { timeout: 5000 })).toBeInTheDocument();
  });
});

describe("queue order and deadlines", () => {
  const item = (id: string, targetAt: string | null, updatedAt: string) =>
    ({ id, targetAt, updatedAt }) as ContentItem;

  it("sorts by target (nulls last), then by the longest wait", () => {
    const sorted = [
      item("a", null, at(5)),
      item("b", "2026-10-20T09:00:00.000Z", at(9)),
      item("c", null, at(1)),
      item("d", "2026-10-15T09:00:00.000Z", at(3)),
      item("e", "2026-10-15T09:00:00.000Z", at(2)),
    ].sort(compareQueue);
    expect(sorted.map((entry) => entry.id)).toEqual(["e", "d", "b", "c", "a"]);
  });

  it("colours the deadline by how close it is", () => {
    const now = Date.parse("2026-10-13T12:00:00.000Z");
    expect(deadlineOf("2026-10-13T09:00:00.000Z", now)).toMatchObject({
      label: "3h late",
      tone: "red",
    });
    expect(deadlineOf("2026-10-13T17:00:00.000Z", now)).toMatchObject({
      label: "Due in 5h",
      tone: "amber",
    });
    expect(deadlineOf("2026-10-15T12:00:00.000Z", now)).toMatchObject({
      label: "Due in 2d",
      tone: "blue",
    });
    expect(deadlineOf("2026-10-21T12:00:00.000Z", now)).toMatchObject({
      label: "Due Oct 21",
      tone: "gray",
    });
    expect(deadlineOf(null, now)).toMatchObject({ label: "No date", tone: "gray" });
  });
});
