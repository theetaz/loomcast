import { SidebarProvider } from "@loomcast/ui/components/sidebar";
import { render, screen, within } from "@testing-library/react";
import { FileIcon } from "lucide-react";
import { describe, expect, it } from "vitest";
import { NavMenu } from "@/app/nav/NavMenu";
import { type NavItem, navItems, navSection } from "@/app/nav/registry";
import { mockChannel } from "@/mocks/calendar";
import { createMockDb } from "@/mocks/db";
import { renderApp } from "./support/render";

function signedInDb() {
  return createMockDb({ signedIn: true });
}

function workspace() {
  return screen.findByRole("navigation", { name: "Workspace" });
}

describe("sidebar navigation registry", () => {
  it("loads every item file once, sorted by order within its section", () => {
    const ids = navItems.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(navSection(navItems, "main").map((item) => item.id)).toEqual([
      "home",
      "projects",
      "library",
      "review",
      "approvals",
      "calendar",
      "analytics",
    ]);
    expect(navSection(navItems, "footer").map((item) => item.id)).toEqual(["guide", "settings"]);
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
  it("links Library, Review and Calendar", async () => {
    renderApp("/", signedInDb());
    const nav = await workspace();

    expect(within(nav).getByRole("link", { name: "Library" })).toHaveAttribute("href", "/library");
    expect(within(nav).getByRole("link", { name: "Review" })).toHaveAttribute("href", "/review");
    expect(within(nav).getByRole("link", { name: "Settings" })).toHaveAttribute(
      "href",
      "/settings",
    );
    expect(within(nav).getByRole("link", { name: "Calendar" })).toHaveAttribute(
      "href",
      "/calendar",
    );
  });

  it("offers to add a channel while there are none", async () => {
    renderApp("/", signedInDb());
    const nav = await workspace();
    const channels = within(nav).getByRole("list", { name: "Channels" });
    expect(await within(channels).findByRole("link", { name: "Add a channel" })).toHaveAttribute(
      "href",
      "/settings/channels",
    );
    expect(within(nav).getByRole("link", { name: "Manage channels" })).toHaveAttribute(
      "href",
      "/settings/channels",
    );
    expect(within(nav).queryByText(/YouTube/)).not.toBeInTheDocument();
  });

  it("lists the channels by platform, each opening the calendar filtered to it", async () => {
    const db = signedInDb();
    const threads = mockChannel({ platform: "threads", displayName: "Rust threads" });
    const x = mockChannel({ platform: "x", displayName: "Rust on X" });
    const facebook = mockChannel({
      platform: "facebook",
      displayName: "Rust Page",
      connected: true,
      status: "needs_reauth",
    });
    db.channels.push(threads, x, facebook);
    renderApp("/", db);
    const nav = await workspace();
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
      `/calendar?channels=${threads.id}`,
    );
  });

  it("marks the open page and opens the library from the sidebar", async () => {
    const { user, router } = renderApp("/", signedInDb());
    const nav = await workspace();
    await user.click(within(nav).getByRole("link", { name: "Library" }));

    await screen.findByRole("heading", { name: "Library", level: 1 });
    expect(router.state.location.pathname).toBe("/library");
    expect(within(nav).getByRole("link", { name: "Library" })).toHaveAttribute(
      "data-active",
      "true",
    );
    expect(within(nav).getByRole("link", { name: "Home" })).not.toHaveAttribute(
      "data-active",
      "true",
    );
  });

  it("opens the review queue from the address", async () => {
    renderApp("/review", signedInDb());
    expect(await screen.findByRole("heading", { name: "Review", level: 1 })).toBeInTheDocument();
    expect(await screen.findByText("Nothing to review")).toBeInTheDocument();
  });
});
