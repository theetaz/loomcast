import { routes } from "@loomcast/contracts";
import { screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setOAuthNavigator } from "@/features/channels/connect/navigation";
import { mockWorkspace } from "@/mocks/db";
import { addMockConnection } from "@/mocks/oauth";
import { CHANNELS_NOW, CHANNELS_WORKSPACE_SLUG, channelsSetup } from "./support/channels";
import { recordRequests } from "./support/kb";
import { renderApp } from "./support/render";

const PAGE = "Rust in 60 seconds (Facebook)";
const THREADS = "Rust threads (Threads)";
const IG = "Rust in 60 seconds (Instagram)";
const AGENTS_PAGE = "Agents for small teams (Facebook)";
const AGENTS_IG = "Agents for small teams (Instagram)";
/** The open workspace's channel settings, where a sign-in returns. */
const RETURN = `/w/${CHANNELS_WORKSPACE_SLUG}/settings/channels`;
const startUrl = (provider: string) =>
  `/api/oauth/${provider}/start?redirectTo=${encodeURIComponent(RETURN)}`;
const META_START = startUrl("meta");
const CONNECT_WORKSPACE_KEY = "loomcast.connect.workspace";

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
    const { db, workspace } = connectSetup();
    const { user } = renderApp(RETURN, db);
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
    // The connect page offers the workspace the sign-in started in.
    expect(window.sessionStorage.getItem(CONNECT_WORKSPACE_KEY)).toBe(workspace.id);

    await user.click(screen.getByRole("button", { name: "Connect" }));
    await user.click(await screen.findByRole("menuitem", { name: /^@?Threads/ }));
    expect(navigate).toHaveBeenLastCalledWith(startUrl("threads"));
  });

  it("offers X only while the server's X publishing flag is on", async () => {
    const { db } = connectSetup({ xPublishing: true });
    const { user } = renderApp(RETURN, db);
    await screen.findByRole("list", { name: "Channel settings" });

    await user.click(screen.getByRole("button", { name: "Connect" }));
    const menu = await screen.findByRole("menu");
    await waitFor(() => expect(within(menu).getAllByRole("menuitem")).toHaveLength(3));
    await user.click(within(menu).getByRole("menuitem", { name: /An X account/ }));
    expect(navigate).toHaveBeenCalledWith(startUrl("x"));
  });
});

describe("account picker", () => {
  it("connects the chosen accounts, their Pages included, and returns to Channels", async () => {
    const { db, channels, workspace } = connectSetup();
    const connection = addMockConnection(db, "meta");
    const requests = recordRequests();
    const { user, router } = renderApp(
      `/channels/connect?connection=${connection.id}&provider=meta`,
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

    await waitFor(() => expect(router.state.location.pathname).toBe(RETURN));
    expect(router.state.location.search).toEqual({});
    expect(requests.find((request) => request.method === "POST")).toMatchObject({
      path: `/api/oauth/connections/${connection.id}/accept`,
      body: {
        workspaceId: workspace.id,
        accountIds: ["facebook:100000000000001", "instagram:178400000000001"],
      },
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
    renderApp(`/channels/connect?connection=${connection.id}&provider=threads`, db);
    expect(await screen.findByRole("checkbox", { name: "rustin60 (Threads)" })).toBeChecked();
    expect(screen.getByRole("button", { name: "Connect account" })).toBeEnabled();
  });

  it("says when the sign-in has expired and offers to sign in again", async () => {
    const { db } = connectSetup();
    const connection = addMockConnection(db, "meta", undefined, {
      now: Date.parse(CHANNELS_NOW) - 31 * 60_000,
    });
    const { user } = renderApp(`/channels/connect?connection=${connection.id}&provider=meta`, db);

    expect(await screen.findByText("This sign-in has expired")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Accounts to connect" })).not.toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "Sign in again" }));
    expect(navigate).toHaveBeenCalledWith(META_START);
    expect(screen.getByRole("link", { name: "Back to channels" })).toHaveAttribute("href", RETURN);
  });

  it("turns into the expired state when the sign-in runs out before the accept", async () => {
    const { db } = connectSetup();
    const connection = addMockConnection(db, "threads");
    const { user } = renderApp(
      `/channels/connect?connection=${connection.id}&provider=threads`,
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
    const { user } = renderApp("/channels/connect?error=access_denied&provider=threads", db);
    expect(await screen.findByText("Sign-in cancelled")).toBeInTheDocument();
    expect(
      screen.getByText(/The sign-in with Threads was cancelled or its permissions were declined/),
    ).toBeInTheDocument();
    // Signing in again starts in the workspace the accounts would join.
    await user.click(await screen.findByRole("button", { name: "Sign in again" }));
    expect(navigate).toHaveBeenCalledWith(startUrl("threads"));
  });

  it("offers no retry for X while its flag is off", async () => {
    const { db } = connectSetup();
    renderApp("/channels/connect?error=not_configured&provider=x", db);
    expect(await screen.findByText("Publishing to X is off")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign in again" })).not.toBeInTheDocument();
  });

  it("offers the sign-ins when there is nothing to finish, ignoring values it can't use", async () => {
    const { db } = connectSetup();
    const { user } = renderApp("/channels/connect?connection=nope&error=other", db);
    const list = await screen.findByRole("list", { name: "Sign-ins" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    await user.click(within(list).getByRole("button", { name: "Sign in with Facebook" }));
    expect(navigate).toHaveBeenCalledWith(META_START);
  });
});

describe("connecting to a workspace", () => {
  /** The channels db with a second workspace, Agents, which has no channels yet. */
  function twoWorkspaces() {
    const setup = connectSetup();
    const agents = mockWorkspace({
      name: "Agents for small teams",
      slug: "agents-for-small-teams",
    });
    setup.db.workspaces.push(agents);
    return { ...setup, agents };
  }

  it("starts from the workspace the sign-in began in and connects to the one chosen", async () => {
    const { db, workspace, agents } = twoWorkspaces();
    window.sessionStorage.setItem(CONNECT_WORKSPACE_KEY, workspace.id);
    const connection = addMockConnection(db, "threads");
    const requests = recordRequests();
    const { user, router } = renderApp(
      `/channels/connect?connection=${connection.id}&provider=threads`,
      db,
    );

    const select = await screen.findByRole("combobox", { name: "Connect to workspace" });
    await waitFor(() => expect(select).toHaveTextContent("Rust in 60 seconds"));
    await user.click(select);
    await user.click(await screen.findByRole("option", { name: "Agents for small teams" }));
    expect(select).toHaveTextContent("Agents for small teams");
    await user.click(screen.getByRole("button", { name: "Connect account" }));

    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/w/${agents.slug}/settings/channels`),
    );
    expect(requests.find((request) => request.method === "POST")).toMatchObject({
      path: `/api/oauth/connections/${connection.id}/accept`,
      body: { workspaceId: agents.id, accountIds: ["threads:200000000000002"] },
    });
    const added = db.channels.find((channel) => channel.externalId === "200000000000002");
    expect(added?.workspaceId).toBe(agents.id);
    // The Agents channel settings list only Agents' channels.
    expect(await screen.findByRole("listitem", { name: "rustin60 (Threads)" })).toBeInTheDocument();
    expect(screen.queryByRole("listitem", { name: PAGE })).not.toBeInTheDocument();
  });

  it("defaults to the remembered workspace of the sign-in", async () => {
    const { db, agents } = twoWorkspaces();
    window.sessionStorage.setItem(CONNECT_WORKSPACE_KEY, agents.id);
    const connection = addMockConnection(db, "threads");
    renderApp(`/channels/connect?connection=${connection.id}&provider=threads`, db);
    const select = await screen.findByRole("combobox", { name: "Connect to workspace" });
    await waitFor(() => expect(select).toHaveTextContent("Agents for small teams"));
  });

  it("names the workspace an account is already connected in", async () => {
    const { db, agents } = twoWorkspaces();
    window.sessionStorage.setItem(CONNECT_WORKSPACE_KEY, agents.id);
    const connection = addMockConnection(db, "meta");
    const { user, router } = renderApp(
      `/channels/connect?connection=${connection.id}&provider=meta`,
      db,
    );

    await user.click(await screen.findByRole("checkbox", { name: PAGE }));
    await user.click(screen.getByRole("button", { name: "Connect account" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "An account you chose is already connected in Rust in 60 seconds.",
    );
    expect(router.state.location.pathname).toBe("/channels/connect");
    expect(db.channels.filter((channel) => channel.workspaceId === agents.id)).toHaveLength(0);
  });
});

describe("channel actions", () => {
  it("shows a reauth banner with Reconnect on a channel that needs reconnecting", async () => {
    const { db } = connectSetup();
    const { user } = renderApp(RETURN, db);
    const row = await screen.findByRole("listitem", { name: THREADS });

    expect(
      within(row).getByText("Reconnect to keep publishing. Nothing posts to Threads until you do."),
    ).toBeInTheDocument();
    // Only the channel that needs it gets the banner.
    expect(
      within(screen.getByRole("listitem", { name: PAGE })).queryByText(/Reconnect to keep/),
    ).not.toBeInTheDocument();
    await user.click(within(row).getByRole("button", { name: "Reconnect" }));
    expect(navigate).toHaveBeenCalledWith(startUrl("threads"));
  });

  it("disconnects a channel only after a confirmation", async () => {
    const { db, channels } = connectSetup();
    const requests = recordRequests();
    const { user } = renderApp(RETURN, db);
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
    const { user } = renderApp(RETURN, db);
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
