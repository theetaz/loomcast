import type { KbSearchHit } from "@loomcast/contracts";
import { KB_SNIPPET_MATCH_END, KB_SNIPPET_MATCH_START } from "@loomcast/contracts";
import { act, screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";
import { matchScore, rankByMatch } from "@/features/palette/match";
import { readRecent, recordRecent } from "@/features/palette/recent";
import { KB_SEARCH_DEBOUNCE_MS } from "@/features/palette/use-kb-search";
import { createMockDb, MOCK_USER, mockId, mockProject } from "@/mocks/db";
import { currentPath, renderApp } from "./support/render";

function setup(role: "owner" | "admin" = "owner") {
  const rust = mockProject({
    name: "Rust in 60 seconds",
    slug: "rust-in-60-seconds",
    updatedAt: "2026-10-12T09:00:00.000Z",
  });
  const postgres = mockProject({
    name: "Postgres tricks",
    slug: "postgres-tricks",
    updatedAt: "2026-10-11T09:00:00.000Z",
  });
  const db = createMockDb({
    signedIn: true,
    user: { ...MOCK_USER, role },
    projects: [rust, postgres],
  });
  return { db, rust, postgres };
}

function hit(projectId: string, title: string, overrides: Partial<KbSearchHit> = {}): KbSearchHit {
  return {
    entryId: mockId(),
    projectId,
    kind: "brainstorm",
    title,
    snippet: `about ${KB_SNIPPET_MATCH_START}${title}${KB_SNIPPET_MATCH_END} and more`,
    score: 1,
    ...overrides,
  };
}

const press = (key: string, init: KeyboardEventInit = {}) =>
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...init }));
  });

const palette = () => screen.getByRole("dialog", { name: "Search or jump to" });
const options = () => within(palette()).queryAllByRole("option");
const selectedOption = () =>
  options().find((option) => option.getAttribute("aria-selected") === "true");

/** Records every knowledge-base search the app sends, with its abort signal. */
function spyOnKbSearches() {
  const realFetch = globalThis.fetch;
  const searches: { q: string; signal: AbortSignal | null | undefined }[] = [];
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname === "/api/kb/search") {
      searches.push({ q: url.searchParams.get("q") ?? "", signal: init?.signal });
    }
    return realFetch(input, init);
  });
  return { searches, spy };
}

afterEach(() => {
  vi.restoreAllMocks();
  document.documentElement.classList.remove("dark");
});

describe("matching", () => {
  it("prefers exact and prefix matches and needs every word otherwise", () => {
    expect(matchScore("", "Anything")).toBeGreaterThan(0);
    expect(matchScore("rust", "Rust")).toBeGreaterThan(matchScore("rust", "Rust in 60 seconds"));
    expect(matchScore("rust", "Rust in 60 seconds")).toBeGreaterThan(
      matchScore("rust", "Learn Rust"),
    );
    expect(matchScore("tok", "Access tokens")).toBeGreaterThan(0);
    expect(matchScore("mcp key", "Access tokens", ["mcp", "key"])).toBeGreaterThan(0);
    expect(matchScore("mcp nope", "Access tokens", ["mcp"])).toBe(0);
    expect(matchScore("cafe", "Café notes")).toBeGreaterThan(0);
    expect(rankByMatch(["Learn Rust", "Rust", "Go"], "rust", (label) => ({ label }))).toEqual([
      "Rust",
      "Learn Rust",
    ]);
  });

  it("keeps recent picks per user, newest first, without duplicates or foreign links", () => {
    const entry = (id: string) => ({ id, source: "projects", label: id, href: `/projects/${id}` });
    recordRecent("u1", entry("a"));
    recordRecent("u1", entry("b"));
    recordRecent("u1", entry("a"));
    recordRecent("u1", { ...entry("evil"), href: "//example.test/phish" });
    recordRecent("u1", { ...entry("evil2"), href: "https://example.test" });
    expect(readRecent("u1").map((item) => item.id)).toEqual(["a", "b"]);
    expect(readRecent("u2")).toEqual([]);
    for (const id of ["c", "d", "e", "f", "g"]) recordRecent("u1", entry(id));
    expect(readRecent("u1").map((item) => item.id)).toEqual(["g", "f", "e", "d", "c"]);

    window.localStorage.setItem(`loomcast-palette-recent:u3`, "{not json");
    expect(readRecent("u3")).toEqual([]);
  });
});

describe("command palette", () => {
  it("opens with ⌘K, Ctrl+K and the topbar button, without any animation", async () => {
    const { db } = setup();
    const { user } = renderApp("/", db);
    await screen.findByRole("button", { name: /search or jump to/i });

    press("k", { metaKey: true });
    expect(palette()).toBeInTheDocument();
    const content = document.querySelector<HTMLElement>("[data-slot=command-dialog-content]");
    const overlay = document.querySelector<HTMLElement>("[data-slot=command-dialog-overlay]");
    for (const element of [content, overlay]) {
      expect(element?.className).not.toMatch(/animate-|transition|duration-/);
      expect(element?.getAttribute("style") ?? "").not.toMatch(/animation|transition/);
    }
    expect(within(palette()).getByRole("combobox")).toHaveFocus();

    // The shortcut toggles; Escape closes.
    press("k", { metaKey: true });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    press("k", { ctrlKey: true });
    expect(palette()).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /search or jump to/i }));
    expect(palette()).toBeInTheDocument();
  });

  it("filters as you type and opens the highlighted item with Enter", async () => {
    const { db } = setup();
    const { user, router } = renderApp("/", db);
    await screen.findByRole("button", { name: /search or jump to/i });

    press("k", { metaKey: true });
    // Before typing: projects, actions and pages.
    expect(
      await within(palette()).findByRole("option", { name: /Postgres tricks/ }),
    ).toBeInTheDocument();
    expect(within(palette()).getByRole("option", { name: "New project" })).toBeInTheDocument();
    expect(within(palette()).getByRole("option", { name: /Members/ })).toBeInTheDocument();

    await user.keyboard("postgr");
    await waitFor(() =>
      expect(options().map((option) => option.textContent)).toEqual([
        "Postgres trickspostgres-tricks",
      ]),
    );
    expect(selectedOption()?.textContent).toContain("Postgres tricks");
    await user.keyboard("{Enter}");

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(currentPath(router)).toBe("/projects/postgres-tricks"));
  });

  it("moves with the arrow keys, wraps, and remembers picks in Recent", async () => {
    const { db } = setup();
    const { user, router } = renderApp("/", db);
    await screen.findByRole("button", { name: /search or jump to/i });

    press("k", { metaKey: true });
    await user.keyboard("tokens");
    await waitFor(() => expect(selectedOption()?.textContent).toContain("Access tokens"));
    await user.keyboard("{Enter}");
    await waitFor(() => expect(currentPath(router)).toBe("/settings/tokens"));

    press("k", { metaKey: true });
    const recent = within(palette()).getByRole("group", { name: "Recent" });
    expect(
      within(recent)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["Access tokensSettings"]);
    // The first row is selected; ArrowUp wraps to the last one, ArrowDown back.
    expect(selectedOption()?.textContent).toBe("Access tokensSettings");
    await user.keyboard("{ArrowUp}");
    expect(selectedOption()).toBe(options().at(-1));
    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(selectedOption()).toBe(options()[1]);

    // Recent only shows while the search is empty.
    await user.keyboard("rust");
    expect(within(palette()).queryByRole("group", { name: "Recent" })).toBeNull();
  });

  it("hides sections a member can't open", async () => {
    const { db } = setup("admin");
    const { user } = renderApp("/", db);
    await screen.findByRole("button", { name: /search or jump to/i });

    press("k", { metaKey: true });
    await user.keyboard("members");
    expect(await within(palette()).findByText(/No results for/)).toBeInTheDocument();
  });

  it("runs actions: new project and the theme", async () => {
    const { db } = setup();
    const { user } = renderApp("/", db);
    await screen.findByRole("button", { name: /search or jump to/i });

    press("k", { metaKey: true });
    await user.keyboard("dark");
    await user.keyboard("{Enter}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(document.documentElement).toHaveClass("dark");

    press("k", { metaKey: true });
    expect(
      within(palette()).getByRole("option", { name: "Switch to light theme" }),
    ).toBeInTheDocument();
    await user.keyboard("new proj");
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("dialog", { name: "New project" })).toBeInTheDocument();
  });

  it("offers a new brainstorm in the open project", async () => {
    const { db, rust } = setup();
    const { user, router } = renderApp(`/projects/${rust.slug}`, db);
    await screen.findByRole("button", { name: /search or jump to/i });

    press("k", { metaKey: true });
    await user.keyboard("brainstorm");
    const option = await within(palette()).findByRole("option", {
      name: "New brainstorm in Rust in 60 seconds",
    });
    await user.click(option);
    await waitFor(() =>
      expect(currentPath(router)).toBe(`/projects/${rust.slug}/kb/new?kind=brainstorm`),
    );
  });
});

describe("knowledge-base search", () => {
  it("waits for two characters and a pause, then opens a hit", async () => {
    const { db, rust } = setup();
    const found = hit(rust.id, "Ownership in one picture");
    const { searches } = spyOnKbSearches();
    const { user, router } = renderApp("/", db, [
      http.get("*/api/kb/search", () => HttpResponse.json({ items: [found] })),
    ]);
    await screen.findByRole("button", { name: /search or jump to/i });

    press("k", { metaKey: true });
    await user.keyboard("o");
    await new Promise((resolve) => setTimeout(resolve, KB_SEARCH_DEBOUNCE_MS + 50));
    expect(searches).toHaveLength(0);

    await user.keyboard("wn");
    const group = await within(palette()).findByRole("group", { name: "Knowledge base" });
    const option = await within(group).findByRole("option", { name: /Ownership in one picture/ });
    expect(searches.map((search) => search.q)).toEqual(["own"]);
    // The match is highlighted with an element, never markup from the server.
    expect(
      within(option).getByText("Ownership in one picture", { selector: "mark" }),
    ).toBeInTheDocument();
    expect(option).toHaveTextContent(rust.name);

    await user.click(option);
    await waitFor(() =>
      expect(currentPath(router)).toBe(`/projects/${rust.slug}/kb/${found.entryId}`),
    );
  });

  it("aborts the request for an older query and never shows its answer", async () => {
    const { db, rust } = setup();
    const { searches } = spyOnKbSearches();
    let releaseSlow: () => void = () => {};
    const slow = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    const { user } = renderApp("/", db, [
      http.get("*/api/kb/search", async ({ request }) => {
        const q = new URL(request.url).searchParams.get("q");
        if (q === "own") {
          await slow;
          return HttpResponse.json({ items: [hit(rust.id, "Stale answer")] });
        }
        return HttpResponse.json({ items: [hit(rust.id, "Borrowing rules")] });
      }),
    ]);
    await screen.findByRole("button", { name: /search or jump to/i });

    press("k", { metaKey: true });
    await user.keyboard("own");
    await waitFor(() => expect(searches).toHaveLength(1));
    expect(
      await within(palette()).findByRole("option", { name: "Searching the knowledge base…" }),
    ).toHaveAttribute("aria-disabled", "true");

    await user.keyboard("er");
    await waitFor(() => expect(searches).toHaveLength(2));
    expect(searches[0]?.signal?.aborted).toBe(true);
    expect(searches[1]?.q).toBe("owner");
    expect(
      await within(palette()).findByRole("option", { name: /Borrowing rules/ }),
    ).toBeInTheDocument();

    releaseSlow();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(within(palette()).queryByText("Stale answer")).toBeNull();
    expect(within(palette()).getByRole("option", { name: /Borrowing rules/ })).toBeInTheDocument();
  });

  it("explains a failed search without hiding the other results", async () => {
    const { db } = setup();
    const { user } = renderApp("/", db, [
      http.get("*/api/kb/search", () =>
        HttpResponse.json({ error: { code: "internal", message: "Boom" } }, { status: 500 }),
      ),
    ]);
    await screen.findByRole("button", { name: /search or jump to/i });

    press("k", { metaKey: true });
    await user.keyboard("rust");
    expect(
      await within(palette()).findByRole("option", { name: /Couldn't search the knowledge base/ }),
    ).toHaveAttribute("aria-disabled", "true");
    expect(
      within(palette()).getByRole("option", { name: /Rust in 60 seconds/ }),
    ).toBeInTheDocument();
  });
});
