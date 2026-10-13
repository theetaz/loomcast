import { routes } from "@loomcast/contracts";
import { screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { seriesCards } from "@/features/series/cards/registry";
import { mockChannel } from "@/mocks/calendar";
import { CHANNELS_NOW, channelsSetup } from "./support/channels";
import { recordRequests } from "./support/kb";
import { renderApp } from "./support/render";
import { seriesSetup } from "./support/series";

beforeEach(() => {
  // Only the clock is fixed; timers stay real for the router, MSW and user-event.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(CHANNELS_NOW));
});
afterEach(() => {
  vi.useRealTimers();
});

function row(name: string) {
  return screen.getByRole("listitem", { name });
}

function dryRunSwitch(name: string) {
  return screen.getByRole("switch", { name: `Dry run for ${name}` });
}

const PAGE = "Rust in 60 seconds (Facebook)";
const PLANNING = "@rustin60 (Instagram)";
const THREADS = "Rust threads (Threads)";
const X = "Rust on X (X)";

describe("channel settings", () => {
  it("lists every channel with its status, the dry-run banner and the Connect menu", async () => {
    const { db } = channelsSetup();
    renderApp("/settings/channels", db);

    const list = await screen.findByRole("list", { name: "Channel settings" });
    expect(
      within(list)
        .getAllByRole("listitem")
        .map((item) => item.getAttribute("aria-label")),
    ).toEqual([PAGE, PLANNING, THREADS, X]);
    expect(within(row(PAGE)).getByText("Active")).toHaveAttribute("data-tone", "green");
    expect(within(row(PLANNING)).getByText("Not connected")).toHaveAttribute("data-tone", "gray");
    expect(within(row(THREADS)).getByText("Needs reconnect")).toHaveAttribute("data-tone", "amber");
    expect(within(row(X)).getByText("Dry-run only")).toBeInTheDocument();
    expect(within(row(PLANNING)).getByText(/Planning channel/)).toBeInTheDocument();

    expect(screen.getByRole("status")).toHaveTextContent(/^Dry-run mode\./);
    const connect = screen.getByRole("button", { name: "Connect" });
    expect(connect).not.toHaveAttribute("aria-disabled");
    expect(connect).toHaveAttribute("aria-haspopup", "menu");
  });

  it("locks the dry-run switch with the server's reason for each channel", async () => {
    const { db } = channelsSetup();
    renderApp("/settings/channels", db);
    await screen.findByRole("list", { name: "Channel settings" });

    const reasons: Record<string, RegExp> = {
      [PAGE]: /The server is in dry-run mode/,
      [PLANNING]: /Connect this channel's account first/,
      [THREADS]: /Reconnect or enable this channel first/,
      [X]: /Publishing live to X isn't available yet/,
    };
    for (const [name, reason] of Object.entries(reasons)) {
      const toggle = dryRunSwitch(name);
      expect(toggle).toBeChecked();
      expect(toggle).toHaveAttribute("aria-disabled", "true");
      expect(toggle).toHaveAccessibleDescription(reason);
    }
  });

  it("ignores clicks on a locked switch and never asks the server", async () => {
    const { db } = channelsSetup();
    const requests = recordRequests();
    const { user } = renderApp("/settings/channels", db);
    await screen.findByRole("list", { name: "Channel settings" });

    await user.click(dryRunSwitch(X));
    expect(dryRunSwitch(X)).toBeChecked();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(requests.some((request) => request.method === "PATCH")).toBe(false);
  });

  it("lets a channel go live after a confirmation once the server allows it", async () => {
    const { db, channels } = channelsSetup({ mode: "live" });
    const requests = recordRequests();
    const { user } = renderApp("/settings/channels", db);
    await screen.findByRole("list", { name: "Channel settings" });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();

    const toggle = dryRunSwitch(PAGE);
    expect(toggle).not.toHaveAttribute("aria-disabled");
    expect(toggle).not.toHaveAccessibleDescription();
    // The others stay locked for their own reasons, whatever the server's mode.
    expect(dryRunSwitch(PLANNING)).toHaveAttribute("aria-disabled", "true");

    await user.click(toggle);
    const confirm = await screen.findByRole("alertdialog", { name: `Publish live on ${PAGE}?` });
    await user.click(within(confirm).getByRole("button", { name: "Keep dry-run" }));
    expect(dryRunSwitch(PAGE)).toBeChecked();
    expect(requests.some((request) => request.method === "PATCH")).toBe(false);

    await user.click(dryRunSwitch(PAGE));
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Publish live" }),
    );
    await waitFor(() => expect(dryRunSwitch(PAGE)).not.toBeChecked());
    expect(requests.find((request) => request.method === "PATCH")).toMatchObject({
      path: `/api/channels/${channels.page.id}`,
      body: { dryRun: false },
    });
    expect(db.channels.find((channel) => channel.id === channels.page.id)?.dryRun).toBe(false);

    // Back to dry-run needs no confirmation.
    await user.click(dryRunSwitch(PAGE));
    await waitFor(() => expect(dryRunSwitch(PAGE)).toBeChecked());
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("puts the switch back and gives the server's reason when it refuses", async () => {
    const { db, channels } = channelsSetup({ mode: "live" });
    const { user } = renderApp("/settings/channels", db, [
      http.patch(`*${routes["channels.update"].path}`, () =>
        HttpResponse.json(
          {
            error: {
              code: "dry_run_locked",
              message: "This channel cannot leave dry-run yet.",
              details: { reason: "not_active" },
            },
          },
          { status: 409 },
        ),
      ),
    ]);
    await screen.findByRole("list", { name: "Channel settings" });
    // The channel needs reconnecting by the time the change arrives.
    const page = db.channels.find((channel) => channel.id === channels.page.id);
    if (page) page.status = "needs_reauth";

    await user.click(dryRunSwitch(PAGE));
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Publish live" }),
    );
    const title = await screen.findByText(`${PAGE} can't leave dry-run`);
    const notice = title.closest("[data-sonner-toast]");
    if (!(notice instanceof HTMLElement)) throw new Error("expected a toast");
    expect(within(notice).getByText("Reconnect or enable this channel first.")).toBeInTheDocument();
    expect(dryRunSwitch(PAGE)).toBeChecked();
    // The list is read again and now shows the server's reason on the switch.
    await waitFor(() =>
      expect(dryRunSwitch(PAGE)).toHaveAccessibleDescription(
        /Reconnect or enable this channel first/,
      ),
    );
  });

  it("switches approval on any channel, even one locked to dry-run", async () => {
    const { db, channels } = channelsSetup();
    const requests = recordRequests();
    const { user } = renderApp("/settings/channels", db);
    await screen.findByRole("list", { name: "Channel settings" });

    const approval = screen.getByRole("switch", { name: `Requires approval for ${X}` });
    expect(approval).not.toBeChecked();
    await user.click(approval);
    await waitFor(() => expect(approval).toBeChecked());
    expect(requests.find((request) => request.method === "PATCH")).toMatchObject({
      path: `/api/channels/${channels.x.id}`,
      body: { requiresApproval: true },
    });
    expect(db.channels.find((channel) => channel.id === channels.x.id)?.requiresApproval).toBe(
      true,
    );
  });

  it("warns about refused and expiring access", async () => {
    const { db } = channelsSetup();
    renderApp("/settings/channels", db);
    const threads = await screen.findByRole("listitem", { name: THREADS });
    expect(
      within(threads).getByText("The platform refused the stored access: The access was revoked."),
    ).toBeInTheDocument();
    expect(
      within(threads).getByText(
        "Access expires in 4 days. Reconnect the account if it isn't renewed.",
      ),
    ).toBeInTheDocument();
    expect(within(row(PAGE)).getByText(/^Checked/)).toBeInTheDocument();
  });

  it("adds a planning channel in dry-run", async () => {
    const { db } = channelsSetup();
    const requests = recordRequests();
    const { user } = renderApp("/settings/channels", db);
    await screen.findByRole("list", { name: "Channel settings" });

    await user.click(screen.getByRole("button", { name: "Add planning channel" }));
    const dialog = await screen.findByRole("dialog", { name: "Add planning channel" });
    await user.click(within(dialog).getByRole("button", { name: "Add channel" }));
    expect(
      within(dialog).getByText("Give the channel a name, such as the account's handle."),
    ).toBeInTheDocument();

    await user.type(within(dialog).getByLabelText("Name"), "@rust.daily");
    await user.click(within(dialog).getByRole("switch", { name: "Requires approval" }));
    await user.click(within(dialog).getByRole("button", { name: "Add channel" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(requests.find((request) => request.method === "POST")?.body).toEqual({
      platform: "instagram",
      displayName: "@rust.daily",
      requiresApproval: true,
    });
    const added = await screen.findByRole("listitem", { name: "@rust.daily (Instagram)" });
    expect(within(added).getByText("Not connected")).toBeInTheDocument();
    expect(
      screen.getByRole("switch", { name: "Dry run for @rust.daily (Instagram)" }),
    ).toHaveAttribute("aria-disabled", "true");
  });

  it("says when publishing is paused", async () => {
    const { db } = channelsSetup({ mode: "live", enabled: false });
    renderApp("/settings/channels", db);
    expect(await screen.findByRole("status")).toHaveTextContent(/^Publishing is paused\./);
  });

  it("is a settings section, opened from the sidebar's channels group", async () => {
    const { db } = channelsSetup();
    const { user, router } = renderApp("/", db);
    const nav = await screen.findByRole("navigation", { name: "Workspace" });
    await user.click(within(nav).getByRole("link", { name: "Manage channels" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/settings/channels"));
    expect(await screen.findByRole("tab", { name: "Channels" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });
});

describe("series channels card", () => {
  function linkedSetup(status: "active" | "archived" = "active") {
    const setup = seriesSetup();
    const at = "2026-10-01T08:00:00.000Z";
    const instagram = mockChannel({
      platform: "instagram",
      displayName: "@rustin60",
      createdAt: at,
    });
    const threads = mockChannel({
      platform: "threads",
      displayName: "Rust threads",
      createdAt: at,
    });
    const old = mockChannel({
      platform: "facebook",
      displayName: "Old page",
      status: "disabled",
      createdAt: at,
    });
    setup.db.channels.push(instagram, threads, old);
    setup.db.seriesChannels.push({
      seriesId: setup.series.ownership.id,
      channels: [{ channelId: instagram.id, enabled: true }],
    });
    const series = setup.db.series.find((entry) => entry.id === setup.series.ownership.id);
    if (series) series.status = status;
    return { ...setup, linked: { instagram, threads, old } };
  }

  const switchFor = (name: string) =>
    screen.getByRole("switch", { name: `Publish Ownership basics to ${name}` });

  it("sits after the cadence and format cards", () => {
    expect(seriesCards.map((card) => [card.id, card.order])).toEqual([
      ["cadence", 10],
      ["format", 20],
      ["channels", 30],
    ]);
  });

  it("switches channels on and off for the series, keeping the other links", async () => {
    const setup = linkedSetup();
    const requests = recordRequests();
    const { user } = renderApp(
      `/projects/${setup.rust.slug}/series/${setup.series.ownership.id}`,
      setup.db,
    );
    const card = await screen.findByRole("region", { name: "Channels" }, { timeout: 5000 });
    await within(card).findByRole("list", { name: "Channels of Ownership basics" });
    // A disabled channel the series never used is left out.
    expect(within(card).queryByText("Old page")).not.toBeInTheDocument();
    expect(switchFor("@rustin60 (Instagram)")).toBeChecked();
    expect(switchFor("Rust threads (Threads)")).not.toBeChecked();

    await user.click(switchFor("Rust threads (Threads)"));
    await waitFor(() => expect(switchFor("Rust threads (Threads)")).toBeChecked());
    await user.click(switchFor("@rustin60 (Instagram)"));
    await waitFor(() => expect(switchFor("@rustin60 (Instagram)")).not.toBeChecked());

    const puts = requests.filter((request) => request.method === "PUT");
    expect(puts.map((request) => request.body)).toEqual([
      {
        channels: [
          { channelId: setup.linked.instagram.id, enabled: true },
          { channelId: setup.linked.threads.id, enabled: true },
        ],
      },
      {
        channels: [
          { channelId: setup.linked.instagram.id, enabled: false },
          { channelId: setup.linked.threads.id, enabled: true },
        ],
      },
    ]);
    expect(
      setup.db.seriesChannels.find((entry) => entry.seriesId === setup.series.ownership.id)
        ?.channels,
    ).toEqual([
      { channelId: setup.linked.instagram.id, enabled: false },
      { channelId: setup.linked.threads.id, enabled: true },
    ]);
  });

  it("locks the switches of an archived series", async () => {
    const setup = linkedSetup("archived");
    renderApp(`/projects/${setup.rust.slug}/series/${setup.series.ownership.id}`, setup.db);
    const card = await screen.findByRole("region", { name: "Channels" }, { timeout: 5000 });
    await within(card).findByRole("list", { name: "Channels of Ownership basics" });
    for (const name of ["@rustin60 (Instagram)", "Rust threads (Threads)"]) {
      expect(switchFor(name)).toHaveAttribute("aria-disabled", "true");
      expect(switchFor(name)).toHaveAccessibleDescription(/The series is archived/);
    }
  });
});
