import { routes } from "@loomcast/contracts";
import { screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setOAuthNavigator } from "@/features/channels/connect/navigation";
import { addMockConnection } from "@/mocks/oauth";
import { CHANNELS_NOW, channelsSetup } from "./support/channels";
import { recordRequests } from "./support/kb";
import { renderApp } from "./support/render";

const PAGE = "Rust in 60 seconds (Facebook)";
const THREADS = "Rust threads (Threads)";
const IG = "Rust in 60 seconds (Instagram)";
const AGENTS_PAGE = "Agents for small teams (Facebook)";
const AGENTS_IG = "Agents for small teams (Instagram)";
const META_START = "/api/oauth/meta/start?redirectTo=%2Fsettings%2Fchannels";

let navigate: ReturnType<typeof vi.fn<(url: string) => void>>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(CHANNELS_NOW));
  navigate = vi.fn<(url: string) => void>();
  setOAuthNavigator(navigate);
});
afterEach(() => {
  setOAuthNavigator(null);
  vi.useRealTimers();
});

/** The channels db, with the Page's account id matching the demo Meta sign-in's first Page. */
function connectSetup(options: { xPublishing?: boolean } = {}) {
  const setup = channelsSetup();
  setup.channels.page.externalId = "100000000000001";
  setup.db.features = { xPublishing: options.xPublishing ?? false };
  return setup;
}

function checkbox(name: string) {
  return screen.getByRole("checkbox", { name });
}

describe("connect menu", () => {
  it("offers Facebook and Threads and leaves the page for the sign-in", async () => {
    const { db } = connectSetup();
    const { user } = renderApp("/settings/channels", db);
    await screen.findByRole("list", { name: "Channel settings" });

    await user.click(screen.getByRole("button", { name: "Connect" }));
    const menu = await screen.findByRole("menu");
    const items = within(menu).getAllByRole("menuitem");
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringMatching(/^fFacebook Page and Instagram/),
      expect.stringMatching(/^@Threads/),
    ]);

    await user.click(within(menu).getByRole("menuitem", { name: /Facebook Page and Instagram/ }));
    expect(navigate).toHaveBeenCalledWith(META_START);

    await user.click(screen.getByRole("button", { name: "Connect" }));
    await user.click(await screen.findByRole("menuitem", { name: /^@?Threads/ }));
    expect(navigate).toHaveBeenLastCalledWith(
      "/api/oauth/threads/start?redirectTo=%2Fsettings%2Fchannels",
    );
  });

  it("offers X only while the server's X publishing flag is on", async () => {
    const { db } = connectSetup({ xPublishing: true });
    const { user } = renderApp("/settings/channels", db);
    await screen.findByRole("list", { name: "Channel settings" });

    await user.click(screen.getByRole("button", { name: "Connect" }));
    const menu = await screen.findByRole("menu");
    await waitFor(() => expect(within(menu).getAllByRole("menuitem")).toHaveLength(3));
    await user.click(within(menu).getByRole("menuitem", { name: /An X account/ }));
    expect(navigate).toHaveBeenCalledWith("/api/oauth/x/start?redirectTo=%2Fsettings%2Fchannels");
  });
});

describe("account picker", () => {
  it("connects the chosen accounts, their Pages included, and returns to Channels", async () => {
    const { db, channels } = connectSetup();
    const connection = addMockConnection(db, "meta");
    const requests = recordRequests();
    const { user, router } = renderApp(
      `/settings/channels/connect?connection=${connection.id}&provider=meta`,
      db,
    );

    const list = await screen.findByRole("list", { name: "Accounts to connect" });
    // Each Page is followed by the Instagram account that publishes through it.
    expect(
      within(list)
        .getAllByRole("checkbox")
        .map((box) => box.getAttribute("aria-label")),
    ).toEqual([PAGE, IG, AGENTS_PAGE, AGENTS_IG]);
    // The Page is already a channel; the others are new. Initials stand in for pictures.
    expect(checkbox(PAGE)).toHaveAccessibleDescription(/already connected/);
    expect(checkbox(IG)).toHaveAccessibleDescription(
      "Instagram · @rustin60 · through Rust in 60 seconds",
    );
    expect(within(list).getAllByText("Connected")).toHaveLength(1);
    expect(list.querySelector("img")).toBeNull();
    expect(screen.getByRole("button", { name: "Connect account" })).toBeDisabled();

    // Choosing an Instagram account chooses its Page; dropping the Page drops it.
    await user.click(checkbox(AGENTS_IG));
    expect(checkbox(AGENTS_PAGE)).toBeChecked();
    await user.click(checkbox(AGENTS_PAGE));
    expect(checkbox(AGENTS_IG)).not.toBeChecked();
    expect(screen.getByText("No account chosen")).toBeInTheDocument();

    await user.click(checkbox(IG));
    expect(checkbox(PAGE)).toBeChecked();
    expect(screen.getByText("2 of 4 chosen")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Connect 2 accounts" }));

    await waitFor(() => expect(router.state.location.pathname).toBe("/settings/channels"));
    expect(router.state.location.search).toEqual({});
    expect(requests.find((request) => request.method === "POST")).toMatchObject({
      path: `/api/oauth/connections/${connection.id}/accept`,
      body: { accountIds: ["facebook:100000000000001", "instagram:178400000000001"] },
    });
    expect(await screen.findByText("Connected 2 channels")).toBeInTheDocument();

    // The Page was reconnected in place; the Instagram account is a new channel, in dry-run.
    const added = await screen.findByRole("listitem", { name: IG });
    expect(within(added).getByText("Active")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: `Dry run for ${IG}` })).toBeChecked();
    expect(db.channels.filter((channel) => channel.platform === "facebook")).toHaveLength(1);
    expect(db.channels.find((channel) => channel.id === channels.page.id)?.connected).toBe(true);
  });

  it("chooses the only account of a sign-in for the user", async () => {
    const { db } = connectSetup();
    const connection = addMockConnection(db, "threads");
    renderApp(`/settings/channels/connect?connection=${connection.id}&provider=threads`, db);
    expect(await screen.findByRole("checkbox", { name: "rustin60 (Threads)" })).toBeChecked();
    expect(screen.getByRole("button", { name: "Connect account" })).toBeEnabled();
  });

  it("says when the sign-in has expired and offers to sign in again", async () => {
    const { db } = connectSetup();
    const connection = addMockConnection(db, "meta", undefined, {
      now: Date.parse(CHANNELS_NOW) - 31 * 60_000,
    });
    const { user } = renderApp(
      `/settings/channels/connect?connection=${connection.id}&provider=meta`,
      db,
    );

    expect(await screen.findByText("This sign-in has expired")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Accounts to connect" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Sign in again" }));
    expect(navigate).toHaveBeenCalledWith(META_START);
    expect(screen.getByRole("link", { name: "Back to channels" })).toHaveAttribute(
      "href",
      "/settings/channels",
    );
  });

  it("turns into the expired state when the sign-in runs out before the accept", async () => {
    const { db } = connectSetup();
    const connection = addMockConnection(db, "threads");
    const { user } = renderApp(
      `/settings/channels/connect?connection=${connection.id}&provider=threads`,
      db,
      [
        http.post(`*${routes["oauth.accept"].path}`, () =>
          HttpResponse.json(
            {
              error: {
                code: "connection_expired",
                message: "This sign-in has expired or was already used.",
              },
            },
            { status: 410 },
          ),
        ),
      ],
    );

    await user.click(await screen.findByRole("button", { name: "Connect account" }));
    expect(await screen.findByText("This sign-in has expired")).toBeInTheDocument();
    expect(db.channels.filter((channel) => channel.platform === "threads")).toHaveLength(1);
  });

  it("explains a failed sign-in from the callback", async () => {
    const { db } = connectSetup();
    const { user } = renderApp(
      "/settings/channels/connect?error=access_denied&provider=threads",
      db,
    );
    expect(await screen.findByText("Sign-in cancelled")).toBeInTheDocument();
    expect(
      screen.getByText(/The sign-in with Threads was cancelled or its permissions were declined/),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Sign in again" }));
    expect(navigate).toHaveBeenCalledWith(
      "/api/oauth/threads/start?redirectTo=%2Fsettings%2Fchannels",
    );
  });

  it("offers no retry for X while its flag is off", async () => {
    const { db } = connectSetup();
    renderApp("/settings/channels/connect?error=not_configured&provider=x", db);
    expect(await screen.findByText("Publishing to X is off")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign in again" })).not.toBeInTheDocument();
  });

  it("offers the sign-ins when there is nothing to finish, ignoring values it can't use", async () => {
    const { db } = connectSetup();
    const { user } = renderApp("/settings/channels/connect?connection=nope&error=other", db);
    const list = await screen.findByRole("list", { name: "Sign-ins" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    await user.click(within(list).getByRole("button", { name: "Sign in with Facebook" }));
    expect(navigate).toHaveBeenCalledWith(META_START);
  });
});

describe("channel actions", () => {
  it("shows a reauth banner with Reconnect on a channel that needs reconnecting", async () => {
    const { db } = connectSetup();
    const { user } = renderApp("/settings/channels", db);
    const row = await screen.findByRole("listitem", { name: THREADS });

    expect(
      within(row).getByText("Reconnect to keep publishing. Nothing posts to Threads until you do."),
    ).toBeInTheDocument();
    // Only the channel that needs it gets the banner.
    expect(
      within(screen.getByRole("listitem", { name: PAGE })).queryByText(/Reconnect to keep/),
    ).not.toBeInTheDocument();
    await user.click(within(row).getByRole("button", { name: "Reconnect" }));
    expect(navigate).toHaveBeenCalledWith(
      "/api/oauth/threads/start?redirectTo=%2Fsettings%2Fchannels",
    );
  });

  it("disconnects a channel only after a confirmation", async () => {
    const { db, channels } = connectSetup();
    const requests = recordRequests();
    const { user } = renderApp("/settings/channels", db);
    await screen.findByRole("list", { name: "Channel settings" });

    // A planning channel has nothing to disconnect.
    await user.click(screen.getByRole("button", { name: "More for @rustin60 (Instagram)" }));
    expect(screen.queryByRole("menuitem", { name: "Disconnect…" })).not.toBeInTheDocument();
    await user.keyboard("{Escape}");

    await user.click(screen.getByRole("button", { name: `More for ${PAGE}` }));
    await user.click(await screen.findByRole("menuitem", { name: "Disconnect…" }));
    const dialog = await screen.findByRole("alertdialog", { name: `Disconnect ${PAGE}?` });
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(requests.some((request) => request.method === "DELETE")).toBe(false);

    await user.click(screen.getByRole("button", { name: `More for ${PAGE}` }));
    await user.click(await screen.findByRole("menuitem", { name: "Disconnect…" }));
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Disconnect" }),
    );

    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(requests.find((request) => request.method === "DELETE")?.path).toBe(
      `/api/channels/${channels.page.id}/connection`,
    );
    const row = screen.getByRole("listitem", { name: PAGE });
    expect(await within(row).findByText("Not connected")).toBeInTheDocument();
    expect(await screen.findByText(`Disconnected ${PAGE}`)).toBeInTheDocument();
  });
});

describe("going live", () => {
  it("needs the words typed out and shows what the server checks", async () => {
    const { db, channels } = channelsSetup({ mode: "live", enabled: false });
    const requests = recordRequests();
    const { user } = renderApp("/settings/channels", db);
    await screen.findByRole("list", { name: "Channel settings" });

    await user.click(screen.getByRole("switch", { name: `Dry run for ${PAGE}` }));
    const dialog = await screen.findByRole("alertdialog", { name: `Publish live on ${PAGE}?` });
    const checks = within(dialog).getByRole("region", { name: "What the server checks" });
    expect(
      within(checks)
        .getAllByRole("listitem")
        .map((item) => [item.textContent, item.getAttribute("data-met")]),
    ).toEqual([
      ["Live publishing to Facebook is available: yes", "true"],
      ["The account is connected: yes", "true"],
      ["The channel is active: yes", "true"],
      ["The server publishes live: yes", "true"],
      ["Publishing is paused: due posts wait until it resumes: no", "false"],
    ]);

    const phrase = within(dialog).getByLabelText("Type publish live to confirm");
    const confirm = within(dialog).getByRole("button", { name: "Publish live" });
    expect(phrase).toHaveFocus();
    expect(confirm).toBeDisabled();
    await user.type(phrase, "Publish Live{Enter}");
    expect(confirm).toBeDisabled();
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();

    await user.clear(phrase);
    await user.type(phrase, "publish live{Enter}");
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(requests.filter((request) => request.method === "PATCH")).toMatchObject([
      { path: `/api/channels/${channels.page.id}`, body: { dryRun: false } },
    ]);
  });
});
