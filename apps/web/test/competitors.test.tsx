import { routes } from "@loomcast/contracts";
import { screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { linksError } from "@/features/competitors/ScanDialog";
import { COMPETITORS_WORKSPACE_SLUG, competitorsSetup } from "./support/competitors";
import { recordRequests } from "./support/kb";
import { renderApp } from "./support/render";

// Active scans are asked for again every 50 ms here instead of every 5 s.
vi.mock("@/features/competitors/polling", () => ({ SCAN_POLL_MS: 50 }));

const NOW = "2026-10-14T08:00:00.000Z";
const BASE = `/w/${COMPETITORS_WORKSPACE_SLUG}/competitors`;

beforeEach(() => {
  // Only the clock is fixed; timers stay real for the router, MSW and user-event.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
});
afterEach(() => {
  vi.useRealTimers();
});

function profileInput() {
  return screen.getByLabelText("Profile link or @handle");
}

describe("competitors list", () => {
  it("lists followed profiles with their numbers, latest scan and report", async () => {
    const { db, report } = competitorsSetup();
    renderApp(BASE, db);

    const list = await screen.findByRole("list", { name: "Followed competitors" });
    expect(
      within(list)
        .getAllByRole("listitem")
        .map((item) => item.getAttribute("aria-label")),
    ).toEqual(["@fastrust (Instagram)", "rustaceans (Facebook)", "@ferris_daily (Threads)"]);

    const fastrust = within(list).getByRole("listitem", { name: "@fastrust (Instagram)" });
    expect(within(fastrust).getByText(/Fast Rust · 248\.3K followers · 412 posts/)).toBeVisible();
    expect(within(fastrust).getByText("Partly done")).toHaveAttribute("data-tone", "amber");
    expect(within(fastrust).getByRole("link", { name: "Report on @fastrust" })).toHaveAttribute(
      "href",
      `/w/${COMPETITORS_WORKSPACE_SLUG}/kb/${report.id}`,
    );

    const page = within(list).getByRole("listitem", { name: "rustaceans (Facebook)" });
    expect(within(page).getByText("Not scanned")).toBeVisible();
    const threads = within(list).getByRole("listitem", { name: "@ferris_daily (Threads)" });
    expect(within(threads).getByText("Analyzing")).toHaveAttribute("data-tone", "violet");

    // The sidebar marks Competitors as the open page of the workspace.
    const nav = screen.getByRole("navigation", { name: "Workspace" });
    expect(within(nav).getByRole("link", { name: "Competitors" })).toHaveAttribute(
      "data-active",
      "true",
    );
  });

  it("explains the feature when nothing is followed yet", async () => {
    const { db } = competitorsSetup();
    db.competitors = [];
    renderApp(BASE, db);
    expect(await screen.findByText("No competitors yet")).toBeVisible();
  });

  it("adds a competitor from an Instagram handle", async () => {
    const { db, workspace } = competitorsSetup();
    const requests = recordRequests();
    const { user } = renderApp(BASE, db);
    await screen.findByRole("list", { name: "Followed competitors" });

    await user.type(profileInput(), "@nasa");
    expect(screen.getByText("@nasa")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Add competitor" }));

    expect(await screen.findByRole("listitem", { name: "@nasa (Instagram)" })).toBeVisible();
    expect(
      requests.find(
        (request) => request.method === "POST" && request.path.endsWith("/competitors"),
      ),
    ).toMatchObject({
      path: `/api/workspaces/${workspace.id}/competitors`,
      body: { url: "@nasa" },
    });
    expect(db.competitors.some((item) => item.handle === "nasa")).toBe(true);
    expect(profileInput()).toHaveValue("");
  });

  it("shows why a link is not a profile without asking the server", async () => {
    const { db } = competitorsSetup();
    const requests = recordRequests();
    const { user } = renderApp(BASE, db);
    await screen.findByRole("list", { name: "Followed competitors" });

    await user.type(profileInput(), "https://www.instagram.com/p/C0ffee/");
    await user.click(screen.getByRole("button", { name: "Add competitor" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "That is a link to a post or a page of the platform; paste the profile link instead.",
    );
    expect(profileInput()).toHaveAttribute("aria-invalid", "true");
    expect(requests.some((request) => request.method === "POST")).toBe(false);

    await user.clear(profileInput());
    await user.type(profileInput(), "https://www.tiktok.com/@someone");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add competitor" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Paste an Instagram, Facebook or Threads profile link.",
    );
  });

  it("says when the workspace already follows the profile", async () => {
    const { db } = competitorsSetup();
    const { user } = renderApp(BASE, db);
    await screen.findByRole("list", { name: "Followed competitors" });

    await user.type(profileInput(), "https://instagram.com/FastRust");
    await user.click(screen.getByRole("button", { name: "Add competitor" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This workspace already follows @FastRust on Instagram.",
    );
    expect(db.competitors).toHaveLength(3);
  });
});

describe("competitor page", () => {
  it("shows the profile, saves notes and removes the competitor", async () => {
    const { db, competitors } = competitorsSetup();
    const { user, router } = renderApp(`${BASE}/${competitors.fastrust.id}`, db);

    const profile = await screen.findByRole("link", { name: /@fastrust/ });
    expect(profile).toHaveAttribute("href", "https://instagram.com/fastrust");
    expect(profile).toHaveAttribute("target", "_blank");
    expect(profile).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getByText(/248\.3K followers · 412 posts/)).toBeVisible();

    const scans = await screen.findByRole("list", { name: "Scans of @fastrust" });
    expect(within(scans).getByText("Partly done")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Edit notes" }));
    await user.type(screen.getByRole("textbox", { name: "Notes" }), "Posts daily at 18:00.");
    await user.click(screen.getByRole("button", { name: "Save notes" }));
    expect(await screen.findByText("Posts daily at 18:00.")).toBeVisible();
    expect(db.competitors.find((item) => item.id === competitors.fastrust.id)?.notes).toBe(
      "Posts daily at 18:00.",
    );

    await user.click(screen.getByRole("button", { name: "Remove" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Remove @fastrust?" });
    expect(dialog).toHaveTextContent(/reports stay in the knowledge base/);
    await user.click(within(dialog).getByRole("button", { name: "Remove competitor" }));

    await waitFor(() => expect(router.state.location.pathname).toBe(BASE));
    expect(db.competitors.some((item) => item.id === competitors.fastrust.id)).toBe(false);
    // The analyses and the report stay in the knowledge base.
    expect(db.kbEntries.some((entry) => entry.tags.includes("competitor-report"))).toBe(true);
  });
});

describe("scan dialog", () => {
  it("requires links for a Facebook Page and checks each one", async () => {
    const { db, competitors } = competitorsSetup();
    const requests = recordRequests();
    const { user, router } = renderApp(`${BASE}/${competitors.page.id}`, db);

    await user.click(await screen.findByRole("button", { name: "Scan" }));
    const dialog = await screen.findByRole("dialog", { name: "Scan rustaceans" });
    // Facebook scans cannot rank by views, so there is no "top N" choice.
    expect(within(dialog).queryByLabelText("Videos to analyse")).not.toBeInTheDocument();
    const links = within(dialog).getByLabelText(/Video links/);

    await user.click(within(dialog).getByRole("button", { name: "Start scan" }));
    expect(within(dialog).getByText("Paste at least one link to a Facebook video.")).toBeVisible();
    expect(links).toHaveAttribute("aria-invalid", "true");
    expect(links).toHaveFocus();

    await user.type(
      links,
      "https://www.facebook.com/reel/123456789{Enter}{Enter}https://www.facebook.com/rustaceans",
    );
    await user.click(within(dialog).getByRole("button", { name: "Start scan" }));
    expect(
      within(dialog).getByText("Line 3 isn't a link to a single public Facebook video."),
    ).toBeVisible();
    expect(requests.some((request) => request.method === "POST")).toBe(false);

    await user.clear(links);
    await user.type(links, "https://www.facebook.com/reel/123456789");
    await user.click(within(dialog).getByRole("button", { name: "Start scan" }));

    await waitFor(() => expect(router.state.location.pathname).toMatch(/\/scans\/[0-9a-f-]+$/));
    expect(requests.find((request) => request.method === "POST")).toMatchObject({
      path: `/api/competitors/${competitors.page.id}/scans`,
      body: { topN: 1, links: ["https://www.facebook.com/reel/123456789"] },
    });
    expect(await screen.findByText("0 of 1 analysed")).toBeVisible();
  });

  it("explains a personal Instagram account and suggests pasting links", async () => {
    const { db, competitors } = competitorsSetup();
    const { user } = renderApp(`${BASE}/${competitors.fastrust.id}`, db, [
      http.post(`*${routes["competitors.scan"].path}`, () =>
        HttpResponse.json(
          {
            error: {
              code: "not_professional_account",
              message: "This account is not a business or creator account.",
            },
          },
          { status: 422 },
        ),
      ),
    ]);

    await user.click(await screen.findByRole("button", { name: "Scan" }));
    const dialog = await screen.findByRole("dialog", { name: "Scan @fastrust" });
    expect(within(dialog).getByText(/most viewed Reels/)).toBeVisible();
    await user.click(within(dialog).getByRole("button", { name: "Start scan" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "@fastrust isn't a business or creator account, so Instagram won't rank its Reels. Paste links to the videos you want analysed instead.",
    );
    expect(within(dialog).getByLabelText(/Video links/)).toHaveFocus();
  });

  it("links to channel settings when no Instagram channel is connected", async () => {
    const { db, competitors } = competitorsSetup();
    db.channels = [];
    const { user } = renderApp(`${BASE}/${competitors.fastrust.id}`, db);

    await user.click(await screen.findByRole("button", { name: "Scan" }));
    const dialog = await screen.findByRole("dialog", { name: "Scan @fastrust" });
    await user.click(within(dialog).getByRole("button", { name: "Start scan" }));

    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent(/needs a connected Instagram channel/);
    expect(within(alert).getByRole("link", { name: /channel settings/ })).toHaveAttribute(
      "href",
      `/w/${COMPETITORS_WORKSPACE_SLUG}/settings/channels`,
    );
  });

  it("checks links against the competitor's platform", () => {
    expect(linksError({ platform: "instagram" }, "")).toBeNull();
    expect(linksError({ platform: "threads" }, "  \n ")).toBe(
      "Paste at least one link to a Threads video.",
    );
    expect(linksError({ platform: "instagram" }, "https://www.facebook.com/reel/123456789")).toBe(
      "Line 1 isn't a link to a single public Instagram video.",
    );
    expect(
      linksError(
        { platform: "instagram" },
        Array.from({ length: 21 }, (_, i) => `https://www.instagram.com/reel/A${i}/`).join("\n"),
      ),
    ).toBe("Paste at most 20 links; this has 21.");
  });
});

describe("scan detail", () => {
  it("ranks the videos with their numbers, analyses and the report", async () => {
    const { db, competitors, scans, videos, report } = competitorsSetup();
    renderApp(`${BASE}/${competitors.fastrust.id}/scans/${scans.finished.id}`, db);

    const table = await screen.findByRole("table", { name: /Videos of the scan/ });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(3);

    const first = rows[0] as HTMLElement;
    expect(within(first).getByText("1")).toBeVisible();
    expect(within(first).getByText("1.5M")).toBeVisible();
    expect(within(first).getByText("88.8K")).toBeVisible();
    expect(within(first).getByText("Analyzed")).toHaveAttribute("data-tone", "green");
    expect(
      within(first).getByRole("link", { name: "This one line breaks every Rust beginner." }),
    ).toHaveAttribute("href", `/w/${COMPETITORS_WORKSPACE_SLUG}/kb/${videos.done[0]?.id}`);
    const original = within(first).getByRole("link", { name: /Original video/ });
    expect(original).toHaveAttribute("href", "https://www.instagram.com/reel/AAA111/");
    expect(original).toHaveAttribute("target", "_blank");
    expect(original).toHaveAttribute("rel", "noopener noreferrer");

    const third = rows[2] as HTMLElement;
    expect(within(third).getByRole("link", { name: "Untitled video" })).toBeVisible();
    expect(within(third).getByText("Failed")).toHaveAttribute("data-tone", "red");

    expect(screen.getByRole("heading", { name: /Scan of @fastrust/ })).toHaveTextContent(
      "Partly done",
    );
    expect(screen.getByRole("alert")).toHaveTextContent("1 video could not be downloaded.");
    expect(await screen.findByRole("heading", { name: report.title })).toBeVisible();
    expect(screen.getByRole("link", { name: "Open report" })).toHaveAttribute(
      "href",
      `/w/${COMPETITORS_WORKSPACE_SLUG}/kb/${report.id}`,
    );
    expect(screen.queryByRole("button", { name: "Cancel scan" })).not.toBeInTheDocument();
  });

  it("polls an active scan and stops once it is done", async () => {
    const { db, competitors, scans, videos } = competitorsSetup();
    const requests = recordRequests();
    const scanPath = `/api/competitor-scans/${scans.active.id}`;
    const polls = () =>
      requests.filter((request) => request.method === "GET" && request.path === scanPath).length;
    renderApp(`${BASE}/${competitors.threads.id}/scans/${scans.active.id}`, db);

    expect(await screen.findByText("1 of 2 analysed")).toBeVisible();
    await waitFor(() => expect(polls()).toBeGreaterThanOrEqual(2));

    // The second video finishes and the report is written.
    const running = db.kbEntries.find((entry) => entry.id === videos.active[1]?.id);
    if (running?.reference) running.reference.analysisStatus = "done";
    const scan = db.competitorScans.find((item) => item.id === scans.active.id);
    if (!scan) throw new Error("The active scan is missing.");
    scan.status = "done";
    scan.finishedAt = NOW;

    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /Scan of @ferris_daily/ })).toHaveTextContent(
        "Done",
      ),
    );
    expect(screen.queryByText(/of 2 analysed/)).not.toBeInTheDocument();
    const settled = polls();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(polls()).toBe(settled);
  });

  it("cancels an active scan after confirming", async () => {
    const { db, competitors, scans } = competitorsSetup();
    const requests = recordRequests();
    const { user } = renderApp(`${BASE}/${competitors.threads.id}/scans/${scans.active.id}`, db);

    await user.click(await screen.findByRole("button", { name: "Cancel scan" }));
    let dialog = await screen.findByRole("alertdialog", { name: "Cancel this scan?" });
    await user.click(within(dialog).getByRole("button", { name: "Keep scanning" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(requests.some((request) => request.path.endsWith("/cancel"))).toBe(false);

    await user.click(screen.getByRole("button", { name: "Cancel scan" }));
    dialog = await screen.findByRole("alertdialog", { name: "Cancel this scan?" });
    await user.click(within(dialog).getByRole("button", { name: "Cancel scan" }));

    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /Scan of @ferris_daily/ })).toHaveTextContent(
        "Cancelled",
      ),
    );
    expect(screen.queryByRole("button", { name: "Cancel scan" })).not.toBeInTheDocument();
    expect(db.competitorScans.find((item) => item.id === scans.active.id)?.status).toBe(
      "cancelled",
    );
    expect(requests.find((request) => request.path.endsWith("/cancel"))).toMatchObject({
      method: "POST",
      path: `/api/competitor-scans/${scans.active.id}/cancel`,
    });
  });
});
