import { SidebarProvider } from "@loomcast/ui/components/sidebar";
import { render, screen, within } from "@testing-library/react";
import { FileIcon } from "lucide-react";
import { describe, expect, it } from "vitest";
import { NavMenu } from "@/app/nav/NavMenu";
import { type NavItem, navItems, navSection } from "@/app/nav/registry";
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
      "calendar",
      "analytics",
    ]);
    expect(navSection(navItems, "footer").map((item) => item.id)).toEqual(["settings"]);
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

  it("lists the planned channels: Facebook, Instagram, Threads and X", async () => {
    renderApp("/", signedInDb());
    const nav = await workspace();
    const channels = within(nav).getByRole("list", { name: "Channels" });
    expect(
      within(channels)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Facebook", "Instagram", "Threads", "X"]);
    expect(within(nav).queryByText(/YouTube/)).not.toBeInTheDocument();
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
