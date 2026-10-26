import { act, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { addMetricsCapture, mockLivePost } from "@/mocks/analytics";
import { analyticsSetup, daysAgo } from "./support/analytics";
import { renderItem } from "./support/content-item";
import { recordRequests } from "./support/kb";
import { fakeStream } from "./support/live";
import { renderApp } from "./support/render";

function tile(label: string) {
  const term = screen.getByText(label, { selector: "dt" });
  return term.parentElement as HTMLElement;
}

function points(name: RegExp) {
  return within(screen.getByRole("list", { name })).getAllByRole("button");
}

/** The cells of every body row of the table, as text. */
function tableRows(table: HTMLElement): string[][] {
  return within(table)
    .getAllByRole("row")
    .slice(1)
    .map((row) => Array.from(row.querySelectorAll("th, td"), (cell) => cell.textContent ?? ""));
}

const SLUG = "rust-in-60-seconds";
const BASE = `/w/${SLUG}/analytics`;

describe("analytics overview", () => {
  it("shows the headline figures, the trend per platform and the top posts", async () => {
    const { db, items } = analyticsSetup();
    renderApp(BASE, db);
    await screen.findByRole("heading", { name: "Views over time" }, { timeout: 5000 });

    expect(within(tile("Posts published")).getByText("4")).toBeInTheDocument();
    expect(within(tile("Total views")).getByText("8.6K")).toBeInTheDocument();
    expect(within(tile("Median views per post")).getByText("1.9K")).toBeInTheDocument();
    // (340 + 84 + 175 + 63) interactions over 8,600 views.
    expect(within(tile("Engagement rate")).getByText("7.7%")).toBeInTheDocument();

    const legend = screen.getByRole("list", { name: "Legend" });
    expect(
      within(legend)
        .getAllByRole("listitem")
        .map((entry) => entry.textContent),
    ).toEqual(["Facebook900", "Instagram6.5K", "Threads1.2K"]);
    // One point per day of the last 30 days, sharing one tab stop.
    const days = points(/Views over time, by day/);
    expect(days).toHaveLength(30);
    expect(days.filter((point) => point.tabIndex === 0)).toHaveLength(1);
    expect(days.at(-1)).toHaveAccessibleName(/: 900, Facebook · no posts; 6,500, Instagram/);

    const top = screen.getByRole("table", { name: "Top posts by views" });
    const rows = tableRows(top);
    expect(rows.map((row) => [row[1], row[2], row[4]])).toEqual([
      ["Borrowing basics", "Instagram", "4,000"],
      ["Moves explained", "Instagram", "2,500"],
      ["Borrowing basics", "Threads", "1,200"],
      ["Moves explained", "Facebook", "900"],
    ]);
    expect(within(top).getAllByRole("link", { name: "Borrowing basics" })[0]).toHaveAttribute(
      "href",
      `/w/${SLUG}/content/${items.borrowing.id}`,
    );
    expect(
      within(top).getByRole("link", { name: "Open “Moves explained” on Facebook" }),
    ).toHaveAttribute("href", expect.stringMatching(/^https:\/\/www\.facebook\.com\/reel\//));
  });

  it("lists the same values in the table view as the chart's points", async () => {
    const { db } = analyticsSetup();
    const { user } = renderApp(BASE, db);
    await screen.findByRole("heading", { name: "Views over time" }, { timeout: 5000 });
    const labels = points(/Views over time, by day/).map(
      (point) => point.getAttribute("aria-label") ?? "",
    );

    await user.click(screen.getByRole("tab", { name: "Table" }));
    const table = await screen.findByRole("table", { name: "Views over time, per platform" });
    const header = within(table)
      .getAllByRole("columnheader")
      .map((cell) => cell.textContent);
    expect(header).toEqual([
      "Day",
      "Facebook total",
      "Added",
      "Posts",
      "Instagram total",
      "Added",
      "Posts",
      "Threads total",
      "Added",
      "Posts",
    ]);
    const rows = tableRows(table);
    expect(rows).toHaveLength(labels.length);
    rows.forEach((row, index) => {
      const label = labels[index] ?? "";
      const [day, facebook, , , instagram, , , threads] = row;
      expect(label.startsWith(`${day}: `)).toBe(true);
      expect(label).toContain(`${facebook}, Facebook`);
      expect(label).toContain(`${instagram}, Instagram`);
      expect(label).toContain(`${threads}, Threads`);
    });
    expect(rows.at(-1)?.slice(1)).toEqual(["900", "0", "0", "6,500", "0", "0", "1,200", "0", "0"]);

    await user.click(screen.getByRole("tab", { name: "Chart" }));
    expect(
      await screen.findByRole("list", { name: /Views over time, by day/ }),
    ).toBeInTheDocument();
  });

  it("moves between points with the keyboard and shows their tooltip", async () => {
    const { db } = analyticsSetup();
    const { user } = renderApp(BASE, db);
    await screen.findByRole("heading", { name: "Views over time" }, { timeout: 5000 });
    const days = points(/Views over time, by day/);

    act(() => days[0]?.focus());
    let tooltip = await screen.findByTestId("chart-tooltip");
    expect(tooltip).toHaveTextContent(days[0]?.getAttribute("aria-label")?.split(":")[0] ?? "");

    await user.keyboard("{ArrowRight}");
    expect(days[1]).toHaveFocus();
    expect(days[1]).toHaveAttribute("tabindex", "0");
    expect(days[0]).toHaveAttribute("tabindex", "-1");

    await user.keyboard("{End}");
    expect(days.at(-1)).toHaveFocus();
    tooltip = screen.getByTestId("chart-tooltip");
    expect(within(tooltip).getByText("6,500")).toBeInTheDocument();
    expect(within(tooltip).getByText("Instagram · no posts")).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("chart-tooltip")).not.toBeInTheDocument();
    await user.keyboard("{Home}");
    expect(days[0]).toHaveFocus();
    await user.tab();
    expect(screen.queryByTestId("chart-tooltip")).not.toBeInTheDocument();
  });

  it("says when nothing went live in the range", async () => {
    const { db } = analyticsSetup();
    db.livePosts = [];
    const { user } = renderApp(BASE, db);
    expect(
      await screen.findByText("Nothing went live in this range", undefined, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Views over time" })).not.toBeInTheDocument();

    const requests = recordRequests();
    await user.click(screen.getByRole("button", { name: "Show the last 12 months" }));
    await waitFor(() =>
      expect(requests.some((request) => request.path === "/api/analytics/overview")).toBe(true),
    );
  });

  it("asks for more data before drawing a trend without insights", async () => {
    const { db, items } = analyticsSetup();
    db.livePosts = [
      mockLivePost({ item: items.moves, platform: "instagram", publishedAt: daysAgo(0) }),
    ];
    const { user } = renderApp(BASE, db);
    await screen.findByRole("heading", { name: "Views over time" }, { timeout: 5000 });
    expect(within(tile("Posts published")).getByText("1 waiting for insights")).toBeInTheDocument();
    expect(within(tile("Total views")).getByText("—")).toBeInTheDocument();
    expect(within(tile("Engagement rate")).getByText("—")).toBeInTheDocument();
    const chart = screen.getByRole("region", { name: "Views over time" });
    expect(within(chart).getByText("Not enough data yet")).toBeInTheDocument();
    expect(within(chart).queryByRole("list", { name: /by day/ })).not.toBeInTheDocument();
    expect(screen.getByRole("table", { name: "Top posts by views" })).toHaveTextContent(
      "Not measured yet",
    );

    // The table view still lists the range.
    await user.click(within(chart).getByRole("tab", { name: "Table" }));
    expect(tableRows(within(chart).getByRole("table"))).toHaveLength(30);
  });

  it("asks for the open workspace's posts only", async () => {
    const { db, workspace } = analyticsSetup();
    const requests = recordRequests();
    renderApp(BASE, db);
    await screen.findByRole("heading", { name: "Views over time" }, { timeout: 5000 });
    // The workspace is the page's; there is no workspace filter.
    expect(screen.queryByRole("combobox", { name: "Workspace" })).not.toBeInTheDocument();
    const overviews = requests.filter((request) => request.path === "/api/analytics/overview");
    expect(overviews.length).toBeGreaterThan(0);
    expect(overviews.every((request) => request.query.get("workspaceId") === workspace.id)).toBe(
      true,
    );
  });
});

describe("series analytics", () => {
  it("draws views and watch time per post, by publish date", async () => {
    const { db, series } = analyticsSetup();
    renderApp(`${BASE}/series/${series.id}`, db);
    expect(
      await screen.findByRole("heading", { name: "Ownership basics", level: 1 }, { timeout: 5000 }),
    ).toBeInTheDocument();
    await screen.findByRole("heading", { name: "Views per post" });
    expect(within(tile("Average watch time")).getByText("11.1 s")).toBeInTheDocument();

    const views = points(/Views per post, one bar per post/);
    expect(views.map((point) => point.getAttribute("aria-label"))).toEqual([
      expect.stringMatching(/^Borrowing basics: 4,000 views, Instagram/),
      expect.stringMatching(/^Borrowing basics: 1,200 views, Threads/),
      expect.stringMatching(/^Moves explained: 2,500 views, Instagram/),
      expect.stringMatching(/^Moves explained: 900 views, Facebook/),
    ]);
    const watch = points(/Average watch time per post, one bar per post/);
    expect(watch[1]).toHaveAccessibleName(/^Borrowing basics: Not reported, Threads/);
    expect(watch[0]).toHaveAccessibleName(/^Borrowing basics: 12\.5 s, Instagram/);

    // Threads reports no watch time, so the watch chart's legend leaves it out.
    const watchChart = screen.getByRole("region", { name: "Average watch time per post" });
    expect(
      within(within(watchChart).getByRole("list", { name: "Legend" }))
        .getAllByRole("listitem")
        .map((entry) => entry.textContent),
    ).toEqual(["Facebook", "Instagram"]);
  });

  it("keeps the table twin of the bars in step with their labels", async () => {
    const { db, series } = analyticsSetup();
    const { user } = renderApp(`${BASE}/series/${series.id}`, db);
    const chart = await screen.findByRole("region", { name: "Views per post" }, { timeout: 5000 });
    const labels = points(/Views per post, one bar per post/).map(
      (point) => point.getAttribute("aria-label") ?? "",
    );
    await user.click(within(chart).getByRole("tab", { name: "Table" }));
    const rows = tableRows(within(chart).getByRole("table", { name: "Views per post" }));
    expect(rows).toHaveLength(labels.length);
    rows.forEach(([title, platform, published, value], index) => {
      expect(labels[index]).toBe(`${title}: ${value}, ${platform} · ${published}`);
    });
  });

  it("shows an empty state for a series that never went live", async () => {
    const { db, series } = analyticsSetup();
    db.livePosts = [];
    renderApp(`${BASE}/series/${series.id}`, db);
    expect(
      await screen.findByText("Nothing from this series went live yet", undefined, {
        timeout: 5000,
      }),
    ).toBeInTheDocument();
  });

  it("needs two measured posts before drawing bars", async () => {
    const { db, series, posts } = analyticsSetup();
    db.livePosts = [posts.borrowingInstagram, posts.borrowingThreads];
    renderApp(`${BASE}/series/${series.id}`, db);
    const watch = await screen.findByRole(
      "region",
      { name: "Average watch time per post" },
      { timeout: 5000 },
    );
    expect(within(watch).getByText("Not enough data yet")).toBeInTheDocument();
    expect(within(watch).getByText(/Threads doesn't report it/)).toBeInTheDocument();
    const views = screen.getByRole("region", { name: "Views per post" });
    expect(within(views).queryByText("Not enough data yet")).not.toBeInTheDocument();
  });
});

describe("item analytics card", () => {
  it("shows the latest metrics, sparklines, capture times and the post link", async () => {
    const { db, items, posts } = analyticsSetup();
    const { user } = renderItem(db, items.borrowing.id);
    const card = await screen.findByRole("region", { name: "Performance" }, { timeout: 5000 });
    expect(within(card).getByText(/^2 live posts · 5\.2K views/)).toBeInTheDocument();
    const instagram = within(card).getByRole("button", { name: /Instagram/ });
    expect(instagram).toHaveAttribute("aria-pressed", "true");

    const metrics = within(card).getByText("Views", { selector: "dt" })
      .parentElement as HTMLElement;
    expect(within(metrics).getByText("4K")).toBeInTheDocument();
    const spark = within(metrics).getByRole("list", { name: /Views over 4 captures/ });
    expect(within(spark).getAllByRole("button")).toHaveLength(4);
    expect(within(card).getByText("Saves", { selector: "dt" }).parentElement).toHaveTextContent(
      "Not enough data yet",
    );
    expect(within(card).getByText(/Captured/)).toBeInTheDocument();
    expect(within(card).getByRole("link", { name: /Open on Instagram/ })).toHaveAttribute(
      "href",
      posts.borrowingInstagram.post.permalink,
    );

    await user.click(within(card).getByRole("button", { name: /Threads/ }));
    expect(within(card).getByRole("link", { name: /Open on Threads/ })).toBeInTheDocument();
    expect(
      within(card).getByText("Avg. watch time", { selector: "dt" }).parentElement,
    ).toHaveTextContent("Not reported");

    await user.click(within(card).getByRole("tab", { name: "Table" }));
    const table = within(card).getByRole("table", { name: "Threads insights captures" });
    const rows = tableRows(table);
    expect(rows).toHaveLength(2);
    // Newest capture first; the table prints full counts.
    expect(rows[0]?.slice(1, 3)).toEqual(["1,200", "60"]);
  });

  it("refetches when a post gets a new capture", async () => {
    const { db, items, posts } = analyticsSetup();
    const stream = fakeStream(db);
    renderApp(`/w/${SLUG}/content/${items.moves.id}`, db, [], {
      createEventSource: stream.factory,
    });
    const card = await screen.findByRole("region", { name: "Performance" }, { timeout: 5000 });
    const views = () =>
      within(card).getByText("Views", { selector: "dt" }).parentElement as HTMLElement;
    expect(within(views()).getByText("2.5K")).toBeInTheDocument();
    act(() => {
      addMetricsCapture(db, posts.movesInstagram.post.postId, { views: 3_100 });
    });
    await waitFor(() => expect(within(views()).getByText("3.1K")).toBeInTheDocument());
    expect(within(card).getByRole("button", { name: /Instagram/ })).toHaveTextContent("3.1K");
  });

  it("explains a published video without live posts", async () => {
    const { db, items } = analyticsSetup();
    db.livePosts = db.livePosts.filter((live) => live.post.itemId !== items.moves.id);
    renderItem(db, items.moves.id);
    expect(
      await screen.findByText("No live posts to measure", undefined, { timeout: 5000 }),
    ).toBeInTheDocument();
  });

  it("does not ask for analytics on items that never went live", async () => {
    const { db, items } = analyticsSetup();
    const requests = recordRequests();
    renderItem(db, items.draft.id);
    await screen.findByRole("heading", { name: items.draft.title }, { timeout: 5000 });
    expect(screen.queryByRole("region", { name: "Performance" })).not.toBeInTheDocument();
    expect(requests.some((request) => request.path.startsWith("/api/analytics"))).toBe(false);
  });

  it("waits for the first capture of a fresh post", async () => {
    const { db, items } = analyticsSetup();
    db.livePosts = [
      mockLivePost({
        item: items.moves,
        platform: "instagram",
        publishedAt: new Date().toISOString(),
      }),
    ];
    renderItem(db, items.moves.id);
    const card = await screen.findByRole("region", { name: "Performance" }, { timeout: 5000 });
    expect(within(card).getByText("Not enough data yet")).toBeInTheDocument();
    expect(within(card).getByText(/The first insights arrive/)).toBeInTheDocument();
  });
});
