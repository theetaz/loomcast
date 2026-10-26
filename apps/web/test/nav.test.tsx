import { SidebarProvider } from "@loomcast/ui/components/sidebar";
import { render, screen, waitFor, within } from "@testing-library/react";
import { FileIcon } from "lucide-react";
import { describe, expect, it } from "vitest";
import { NavMenu } from "@/app/nav/NavMenu";
import { type NavItem, navItems, navSection } from "@/app/nav/registry";
import { LAST_WORKSPACE_KEY } from "@/features/workspace/home";
import { mockChannel } from "@/mocks/calendar";
import { mockContentItem } from "@/mocks/content";
import { createMockDb, mockWorkspace } from "@/mocks/db";
import { currentPath, renderApp } from "./support/render";

const RUST = "rust-in-60-seconds";

/** Two active workspaces (Rust the most recently updated) and an archived one. */
function workspacesDb() {
  const rust = mockWorkspace({
    name: "Rust in 60 seconds",
    slug: RUST,
    color: "ember",
    updatedAt: "2026-10-12T09:00:00.000Z",
  });
  const agents = mockWorkspace({
    name: "Agents for small teams",
    slug: "agents-for-small-teams",
    updatedAt: "2026-10-11T09:00:00.000Z",
  });
  const shell = mockWorkspace({
    name: "Shell one-liners",
    slug: "shell-one-liners",
    status: "archived",
    updatedAt: "2026-10-13T09:00:00.000Z",
  });
  const db = createMockDb({ signedIn: true, workspaces: [rust, agents, shell] });
  return { db, rust, agents, shell };
}

function sidebar() {
  return screen.findByRole("navigation", { name: "Workspace" });
}

describe("sidebar navigation registry", () => {
  it("loads every item file once, sorted by order within its section", () => {
    const ids = navItems.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(navSection(navItems, "main").map((item) => item.id)).toEqual([
      "overview",
      "calendar",
      "library",
      "review",
      "approvals",
      "analytics",
    ]);
    expect(navSection(navItems, "studio").map((item) => item.id)).toEqual([
      "chat",
      "knowledge",
      "series",
      "competitors",
    ]);
    expect(navSection(navItems, "footer").map((item) => item.id)).toEqual([
      "workspace-settings",
      "guide",
      "settings",
    ]);
  });

  it("defaults to the main section and breaks order ties by id", () => {
    const item = (id: string, order: number, extra: Partial<NavItem> = {}): NavItem => ({
      id,
      label: id,
      icon: FileIcon,
      order,
      ...extra,
    });
    const items = [item("b", 1), item("a", 1), item("z", 0, { section: "footer" }), item("c", 0)];
    expect(navSection(items, "main").map((entry) => entry.id)).toEqual(["c", "a", "b"]);
    expect(navSection(items, "footer").map((entry) => entry.id)).toEqual(["z"]);
  });

  it("renders items without a page as disabled with a Soon badge", () => {
    const items: NavItem[] = [{ id: "later", label: "Later", icon: FileIcon, order: 0 }];
    render(
      <SidebarProvider>
        <NavMenu section="main" items={items} />
      </SidebarProvider>,
    );
    const button = screen.getByRole("button", { name: "Later" });
    expect(button).toBeDisabled();
    expect(button.closest("li")).toHaveTextContent("Soon");
  });
});

describe("app sidebar", () => {
  it("links the open workspace's pages, its studio and the account", async () => {
    const { db } = workspacesDb();
    renderApp(`/w/${RUST}`, db);
    const nav = await sidebar();

    const href = (name: string) => within(nav).getByRole("link", { name }).getAttribute("href");
    expect(href("Overview")).toBe(`/w/${RUST}`);
    expect(href("Calendar")).toBe(`/w/${RUST}/calendar`);
    expect(href("Library")).toBe(`/w/${RUST}/library`);
    expect(href("Review")).toBe(`/w/${RUST}/review`);
    expect(href("Approvals")).toBe(`/w/${RUST}/approvals`);
    expect(href("Analytics")).toBe(`/w/${RUST}/analytics`);
    expect(href("Chat")).toBe(`/w/${RUST}/chat`);
    expect(href("Knowledge")).toBe(`/w/${RUST}/kb`);
    expect(href("Series")).toBe(`/w/${RUST}/series`);
    expect(href("Competitors")).toBe(`/w/${RUST}/competitors`);
    expect(href("Workspace settings")).toBe(`/w/${RUST}/settings`);
    expect(href("Guide")).toBe("/guide");
    expect(href("Account settings")).toBe("/settings");
    expect(within(nav).getByText("Loomcast")).toBeInTheDocument();
  });

  it("keeps working in the remembered workspace outside one", async () => {
    const { db, agents } = workspacesDb();
    window.localStorage.setItem(LAST_WORKSPACE_KEY, agents.id);
    renderApp("/settings/devices", db);
    const nav = await sidebar();

    expect(
      await within(nav).findByRole("button", { name: /Workspace: Agents for small teams/ }),
    ).toBeInTheDocument();
    expect(within(nav).getByRole("link", { name: "Calendar" })).toHaveAttribute(
      "href",
      "/w/agents-for-small-teams/calendar",
    );
  });

  it("offers to add a channel to the workspace while it has none", async () => {
    const { db, agents } = workspacesDb();
    // Another workspace's channel never shows here.
    db.channels.push(
      mockChannel({ workspaceId: agents.id, platform: "threads", displayName: "Agents" }),
    );
    renderApp(`/w/${RUST}`, db);
    const nav = await sidebar();
    const channels = within(nav).getByRole("list", { name: "Channels" });
    expect(await within(channels).findByRole("link", { name: "Add a channel" })).toHaveAttribute(
      "href",
      `/w/${RUST}/settings/channels`,
    );
    expect(within(nav).getByRole("link", { name: "Manage channels" })).toHaveAttribute(
      "href",
      `/w/${RUST}/settings/channels`,
    );
    expect(within(nav).queryByText("Agents")).not.toBeInTheDocument();
  });

  it("lists the workspace's channels by platform, each opening its calendar filtered to it", async () => {
    const { db, rust, agents } = workspacesDb();
    const threads = mockChannel({
      workspaceId: rust.id,
      platform: "threads",
      displayName: "Rust threads",
    });
    const x = mockChannel({ workspaceId: rust.id, platform: "x", displayName: "Rust on X" });
    const facebook = mockChannel({
      workspaceId: rust.id,
      platform: "facebook",
      displayName: "Rust Page",
      connected: true,
      status: "needs_reauth",
    });
    const elsewhere = mockChannel({
      workspaceId: agents.id,
      platform: "instagram",
      displayName: "@agents",
    });
    db.channels.push(threads, x, facebook, elsewhere);
    renderApp(`/w/${RUST}`, db);
    const nav = await sidebar();
    const channels = within(nav).getByRole("list", { name: "Channels" });
    await within(channels).findByRole("link", { name: /Rust Page/ });
    expect(
      within(channels)
        .getAllByRole("link")
        .map((link) => link.getAttribute("aria-label")),
    ).toEqual([
      "Rust Page (Facebook), needs reconnecting",
      "Rust threads (Threads)",
      "Rust on X (X), dry-run only",
    ]);
    expect(within(channels).getByRole("link", { name: /Rust threads/ })).toHaveAttribute(
      "href",
      `/w/${RUST}/calendar?channels=${threads.id}`,
    );
  });

  it("counts the workspace's videos waiting for review and approval", async () => {
    const { db, rust, agents } = workspacesDb();
    for (const [workspace, title] of [
      [rust, "Moves explained"],
      [rust, "Slices without the confusion"],
      [agents, "Hand-offs"],
    ] as const) {
      const { item, versions } = mockContentItem({
        workspaceId: workspace.id,
        title,
        state: "review",
      });
      db.contentItems.push(item);
      db.contentVersions.push(...versions);
    }
    renderApp(`/w/${RUST}`, db);
    const nav = await sidebar();

    const review = within(nav).getByRole("link", { name: "Review" }).closest("li");
    await waitFor(() => expect(review).toHaveTextContent("Review, 2 waiting for review"));
    const approvals = within(nav).getByRole("link", { name: "Approvals" }).closest("li");
    await waitFor(() => expect(approvals).toHaveTextContent("Approvals, 2 waiting for approval"));
  });

  it("marks the open page and opens the library from the sidebar", async () => {
    const { db } = workspacesDb();
    const { user, router } = renderApp(`/w/${RUST}`, db);
    const nav = await sidebar();
    await user.click(within(nav).getByRole("link", { name: "Library" }));

    await screen.findByRole("heading", { name: "Library", level: 1 });
    expect(router.state.location.pathname).toBe(`/w/${RUST}/library`);
    expect(within(nav).getByRole("link", { name: "Library" })).toHaveAttribute(
      "data-active",
      "true",
    );
    expect(within(nav).getByRole("link", { name: "Overview" })).not.toHaveAttribute(
      "data-active",
      "true",
    );
  });

  it("opens the review queue from the address", async () => {
    const { db } = workspacesDb();
    renderApp(`/w/${RUST}/review`, db);
    expect(await screen.findByRole("heading", { name: "Review", level: 1 })).toBeInTheDocument();
    expect(await screen.findByText("Nothing to review")).toBeInTheDocument();
  });

  it("starts the breadcrumbs at the workspace", async () => {
    const { db } = workspacesDb();
    renderApp(`/w/${RUST}/calendar`, db);
    const trail = await screen.findByRole("navigation", { name: "Breadcrumb" });
    await waitFor(() => expect(trail).toHaveTextContent("Rust in 60 seconds/Calendar"));
    expect(within(trail).getByRole("link", { name: /Rust in 60 seconds/ })).toHaveAttribute(
      "href",
      `/w/${RUST}`,
    );
  });
});

describe("workspace switcher", () => {
  it("lists the active workspaces, marks the open one and switches", async () => {
    const { db } = workspacesDb();
    const { user, router } = renderApp(`/w/${RUST}/calendar`, db);
    const nav = await sidebar();

    await user.click(
      await within(nav).findByRole("button", { name: /Workspace: Rust in 60 seconds/ }),
    );
    const menu = await screen.findByRole("menu");
    const items = within(menu).getAllByRole("menuitem");
    expect(items.map((item) => item.textContent)).toEqual([
      "RRust in 60 seconds, open",
      "AAgents for small teams",
      "All workspaces",
      "New workspace…",
    ]);
    expect(within(menu).queryByText("Shell one-liners")).not.toBeInTheDocument();

    await user.click(within(menu).getByRole("menuitem", { name: /Agents for small teams/ }));
    await screen.findByRole("heading", { name: "Agents for small teams", level: 1 });
    expect(router.state.location.pathname).toBe("/w/agents-for-small-teams");
    expect(window.localStorage.getItem(LAST_WORKSPACE_KEY)).toBe(db.workspaces[1]?.id);
  });

  it("works from the keyboard and opens the new workspace dialog", async () => {
    const { db } = workspacesDb();
    const { user } = renderApp(`/w/${RUST}`, db);
    const nav = await sidebar();
    const trigger = await within(nav).findByRole("button", {
      name: /Workspace: Rust in 60 seconds/,
    });

    trigger.focus();
    await user.keyboard("{Enter}");
    const menu = await screen.findByRole("menu");
    await user.click(within(menu).getByRole("menuitem", { name: "New workspace…" }));

    expect(await screen.findByRole("dialog", { name: "New workspace" })).toBeInTheDocument();
  });
});

describe("opening the app", () => {
  it("opens the remembered workspace", async () => {
    const { db, agents } = workspacesDb();
    window.localStorage.setItem(LAST_WORKSPACE_KEY, agents.id);
    const { router } = renderApp("/", db);

    await screen.findByRole("heading", { name: "Agents for small teams", level: 1 });
    expect(currentPath(router)).toBe("/w/agents-for-small-teams");
  });

  it("opens the most recent active workspace when the remembered one is archived", async () => {
    const { db, shell } = workspacesDb();
    window.localStorage.setItem(LAST_WORKSPACE_KEY, shell.id);
    const { router } = renderApp("/", db);

    await screen.findByRole("heading", { name: "Rust in 60 seconds", level: 1 });
    expect(currentPath(router)).toBe(`/w/${RUST}`);
    expect(window.localStorage.getItem(LAST_WORKSPACE_KEY)).toBe(db.workspaces[0]?.id);
  });

  it("opens the workspace list when there is no workspace", async () => {
    const { router } = renderApp("/", createMockDb({ signedIn: true }));

    expect(await screen.findByText("No workspaces yet")).toBeInTheDocument();
    expect(currentPath(router)).toBe("/workspaces");
  });

  it("swaps a workspace id in the address for its slug", async () => {
    const { db, agents } = workspacesDb();
    const { router } = renderApp(`/w/${agents.id}/calendar?view=month`, db);

    await waitFor(() =>
      expect(currentPath(router)).toBe("/w/agents-for-small-teams/calendar?view=month"),
    );
  });
});

describe("old addresses", () => {
  it("moves project and workspace pages under /w", async () => {
    const { db } = workspacesDb();
    const { router } = renderApp(`/projects/${RUST}/kb`, db);
    await screen.findByRole("heading", { name: "Knowledge", level: 1 });
    expect(currentPath(router)).toBe(`/w/${RUST}/kb`);
  });

  it("keeps the search of an old workspace address", async () => {
    const { db } = workspacesDb();
    const { router } = renderApp(`/workspaces/${RUST}/kb?kind=decision`, db);
    await screen.findByRole("heading", { name: "Knowledge", level: 1 });
    expect(currentPath(router)).toBe(`/w/${RUST}/kb?kind=decision`);
  });

  it("opens top-level pages in the remembered workspace, keeping their search", async () => {
    const { db, agents } = workspacesDb();
    window.localStorage.setItem(LAST_WORKSPACE_KEY, agents.id);
    const { router } = renderApp("/calendar?view=month", db);

    await screen.findByRole("heading", { name: "Calendar", level: 1 });
    expect(currentPath(router)).toBe("/w/agents-for-small-teams/calendar?view=month");
  });

  it("opens an old item address in the item's workspace", async () => {
    const { db, agents } = workspacesDb();
    const { item, versions } = mockContentItem({ workspaceId: agents.id, title: "Hand-offs" });
    db.contentItems.push(item);
    db.contentVersions.push(...versions);
    const { router } = renderApp(`/content/${item.id}`, db);

    await screen.findByRole("heading", { name: "Hand-offs", level: 1 });
    expect(currentPath(router)).toBe(`/w/agents-for-small-teams/content/${item.id}`);
  });
});
