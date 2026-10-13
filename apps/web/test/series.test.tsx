import type { Series } from "@loomcast/contracts";
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { seriesCards } from "@/features/series/cards/registry";
import { sortSeries } from "@/features/series/SeriesList";
import { mockSeries } from "@/mocks/content";
import { recordRequests } from "./support/kb";
import { renderApp } from "./support/render";
import { seriesSetup } from "./support/series";

async function seriesTable() {
  const caption = await screen.findByText(/^Series of /, {}, { timeout: 5000 });
  return caption.closest("table") as HTMLTableElement;
}

function rowOf(table: HTMLElement, name: string) {
  return within(table).getByRole("link", { name }).closest("tr") as HTMLTableRowElement;
}

describe("series list", () => {
  it("shows each series with its format, status, cadence and next video", async () => {
    const setup = seriesSetup();
    renderApp(`/projects/${setup.rust.slug}/series`, setup.db);
    const table = await seriesTable();

    const names = within(table)
      .getAllByRole("row")
      .slice(1)
      .map((row) => within(row).getAllByRole("cell")[0]?.querySelector("a")?.textContent);
    expect(names).toEqual(["Error handling", "Ownership basics"]);

    const ownership = within(rowOf(table, "Ownership basics"));
    expect(ownership.getByText("Active")).toHaveAttribute("data-tone", "green");
    // The cadence column, and the line under the name that stands in for it on phones.
    expect(
      await ownership.findAllByText("Mon, Wed, Fri at 09:00, 18:00 · Europe/London"),
    ).toHaveLength(2);
    expect(ownership.getByText(/^Next slot /)).toBeInTheDocument();
    expect(await ownership.findByRole("link", { name: setup.items.moves.title })).toHaveAttribute(
      "href",
      `/content/${setup.items.moves.id}`,
    );
    expect(ownership.getByText(/2 more/)).toBeInTheDocument();

    const errors = within(rowOf(table, "Error handling"));
    expect(errors.getAllByText("Tue, Thu at 12:30 · UTC")).toHaveLength(2);
    expect(errors.getByRole("link", { name: setup.items.question.title })).toBeInTheDocument();
  });

  it("folds archived series away until asked for", async () => {
    const setup = seriesSetup();
    setup.db.series.push(
      mockSeries({
        projectId: setup.rust.id,
        name: "Macros, gently",
        status: "archived",
        formatId: setup.formats.errors.id,
      }),
    );
    const { user } = renderApp(`/projects/${setup.rust.slug}/series`, setup.db);
    const table = await seriesTable();
    expect(within(table).queryByRole("link", { name: "Macros, gently" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Show archived (1)" }));
    expect(within(table).getByRole("link", { name: "Macros, gently" })).toBeInTheDocument();
    expect(
      within(rowOf(table, "Macros, gently")).getByText("No slots while not active"),
    ).toBeInTheDocument();
  });

  it("creates a series with a new format and opens its rules", async () => {
    const setup = seriesSetup();
    const requests = recordRequests();
    const { user, router } = renderApp(`/projects/${setup.rust.slug}/series`, setup.db);
    await seriesTable();
    await user.click(screen.getByRole("button", { name: "New series" }));
    const dialog = await screen.findByRole("dialog", { name: "New series" });
    await user.click(within(dialog).getByRole("button", { name: "Create series" }));
    expect(within(dialog).getByText("Give the series a name.")).toBeInTheDocument();

    await user.type(within(dialog).getByLabelText("Name"), "Traits in practice");
    await user.click(within(dialog).getByRole("button", { name: "Create series" }));

    await screen.findByRole("form", { name: "Format rules" }, { timeout: 5000 });
    const created = setup.db.series.find((series) => series.name === "Traits in practice");
    expect(created).toBeDefined();
    expect(router.state.location.pathname).toBe(
      `/projects/${setup.rust.slug}/series/${created?.id}/format`,
    );
    const format = setup.db.formats.find((entry) => entry.id === created?.formatId);
    expect(format?.name).toBe("Traits in practice");
    expect(requests.map((request) => `${request.method} ${request.path}`)).toContain(
      `POST /api/projects/${setup.rust.id}/formats`,
    );
  });

  it("orders active, then paused, then archived series by name", () => {
    const series = (name: string, status: Series["status"]) =>
      mockSeries({ projectId: "p", name, status });
    expect(
      sortSeries([
        series("b", "archived"),
        series("c", "paused"),
        series("z", "active"),
        series("a", "active"),
      ]).map((entry) => entry.name),
    ).toEqual(["a", "z", "c", "b"]);
  });
});

describe("series detail", () => {
  it("lists upcoming videos beside the cadence and format cards", async () => {
    const setup = seriesSetup();
    renderApp(`/projects/${setup.rust.slug}/series/${setup.series.ownership.id}`, setup.db);
    expect(
      await screen.findByRole("heading", { name: "Ownership basics", level: 2 }, { timeout: 5000 }),
    ).toBeInTheDocument();

    const upcoming = screen.getByRole("region", { name: "Upcoming videos" });
    await waitFor(() =>
      expect(
        within(upcoming)
          .getAllByRole("listitem")
          .map((item) => item.textContent),
      ).toEqual([
        expect.stringContaining(setup.items.moves.title),
        expect.stringContaining(setup.items.lifetimes.title),
        expect.stringContaining(setup.items.borrow.title),
      ]),
    );

    const cadence = screen.getByRole("region", { name: "Cadence" });
    expect(
      await within(cadence).findByText("Mon, Wed, Fri at 09:00, 18:00 · Europe/London"),
    ).toBeInTheDocument();
    expect(within(cadence).getByText("36 h before each slot")).toBeInTheDocument();
    expect(within(cadence).getAllByRole("listitem")).toHaveLength(5);

    const format = screen.getByRole("region", { name: "Format" });
    expect(within(format).getByText("voice-ava")).toBeInTheDocument();
    expect(within(format).getByRole("link", { name: "Edit rules" })).toHaveAttribute(
      "href",
      `/projects/${setup.rust.slug}/series/${setup.series.ownership.id}/format`,
    );
  });

  it("pauses after a confirmation, resumes, then archives", async () => {
    const setup = seriesSetup();
    const { user } = renderApp(
      `/projects/${setup.rust.slug}/series/${setup.series.ownership.id}`,
      setup.db,
    );
    await screen.findByRole("heading", { name: "Ownership basics", level: 2 }, { timeout: 5000 });

    await user.click(screen.getByRole("button", { name: "Pause" }));
    const pause = await screen.findByRole("alertdialog", { name: "Pause Ownership basics?" });
    await user.click(within(pause).getByRole("button", { name: "Pause series" }));
    expect(await screen.findByText(/^Paused\. No videos are planned/)).toBeInTheDocument();
    expect(setup.db.series.find((entry) => entry.id === setup.series.ownership.id)?.status).toBe(
      "paused",
    );
    expect(
      within(screen.getByRole("region", { name: "Cadence" })).getByText(
        "None while the series is paused.",
      ),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Resume" }));
    await waitFor(() => expect(screen.queryByText(/^Paused\./)).toBeNull());
    expect(screen.getByText("Active")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Archive" }));
    const archive = await screen.findByRole("alertdialog", { name: "Archive Ownership basics?" });
    await user.click(within(archive).getByRole("button", { name: "Archive series" }));
    expect(await screen.findByText(/^Archived\. The series plans nothing new/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
    expect(screen.queryByRole("button", { name: "New idea" })).toBeNull();
  });

  it("says when a series is not in this project", async () => {
    const setup = seriesSetup();
    renderApp(`/projects/${setup.rust.slug}/series/${setup.series.patterns.id}`, setup.db);
    expect(await screen.findByText("Series not found", {}, { timeout: 5000 })).toBeInTheDocument();
  });

  it("takes its side cards from the registry, cadence first", () => {
    expect(seriesCards.map((card) => card.id)).toEqual(["cadence", "format"]);
    expect(seriesCards.map((card) => card.order)).toEqual([10, 20]);
  });
});
