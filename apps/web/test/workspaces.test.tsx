import { screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { createMockDb, mockWorkspace } from "@/mocks/db";
import { renderApp } from "./support/render";
import { server } from "./support/server";

function signedInDb(
  workspaces = [
    mockWorkspace({
      name: "Rust in 60 seconds",
      slug: "rust-in-60-seconds",
      updatedAt: "2026-10-12T09:00:00.000Z",
    }),
    mockWorkspace({
      name: "Agents for small teams",
      slug: "agents-for-small-teams",
      updatedAt: "2026-10-11T09:00:00.000Z",
    }),
    mockWorkspace({
      name: "Shell one-liners",
      slug: "shell-one-liners",
      status: "archived",
      updatedAt: "2026-10-01T09:00:00.000Z",
    }),
  ],
) {
  return createMockDb({ signedIn: true, workspaces });
}

describe("workspaces list", () => {
  it("renders active workspaces as cards with slug, description and age, newest first", async () => {
    const db = signedInDb();
    const rust = db.workspaces[0];
    if (rust) rust.description = "One Rust idea per short.";
    renderApp("/workspaces", db);

    const list = await screen.findByRole("list", { name: "Active workspaces" });
    const cards = within(list).getAllByRole("link");
    expect(cards.map((card) => card.textContent)).toEqual([
      expect.stringContaining("Rust in 60 seconds"),
      expect.stringContaining("Agents for small teams"),
    ]);
    const first = within(cards[0] as HTMLElement);
    expect(first.getByText("rust-in-60-seconds")).toBeInTheDocument();
    expect(first.getByText("One Rust idea per short.")).toBeInTheDocument();
    expect(within(cards[1] as HTMLElement).getByText("No description yet.")).toBeInTheDocument();
    expect(cards[0]?.querySelector("time")).toHaveAttribute("datetime", "2026-10-12T09:00:00.000Z");
    expect(cards[0]).toHaveAttribute("href", "/w/rust-in-60-seconds");
    expect(screen.queryByText("Shell one-liners")).not.toBeInTheDocument();
  });

  it("shows archived workspaces behind a switch kept in the address", async () => {
    const { user, router } = renderApp("/workspaces", signedInDb());

    const toggle = await screen.findByRole("switch", { name: /Show archived/ });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    await user.click(toggle);

    const list = await screen.findByRole("list", { name: "Archived workspaces" });
    expect(within(list).getByText("Shell one-liners")).toBeInTheDocument();
    expect(router.state.location.search).toEqual({ archived: true });

    await user.click(screen.getByRole("switch", { name: /Show archived/ }));
    await waitFor(() =>
      expect(screen.queryByRole("list", { name: "Archived workspaces" })).not.toBeInTheDocument(),
    );
    expect(router.state.location.search).toEqual({});
  });

  it("shows an empty state with a way to start", async () => {
    renderApp("/workspaces", signedInDb([]));

    expect(await screen.findByText("No workspaces yet")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "New workspace" })).toHaveLength(2);
  });

  it("shows the error and retries", async () => {
    let fail = true;
    const { user } = renderApp("/workspaces", signedInDb(), [
      http.get("*/api/workspaces", () =>
        fail
          ? HttpResponse.json({ error: { code: "internal", message: "Boom" } }, { status: 500 })
          : HttpResponse.json({ items: [] }),
      ),
    ]);

    expect(await screen.findByText("Couldn't load workspaces")).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole("button", { name: /try again/i }));
    expect(await screen.findByText("No workspaces yet")).toBeInTheDocument();
  });
});

describe("new workspace dialog", () => {
  it("previews the slug, calls the API and opens the new workspace", async () => {
    const db = signedInDb();
    const posted: unknown[] = [];
    server.events.on("request:start", async ({ request }) => {
      if (request.method === "POST" && new URL(request.url).pathname === "/api/workspaces") {
        posted.push(await request.clone().json());
      }
    });
    const { user, router } = renderApp("/workspaces", db);

    await user.click(await screen.findByRole("button", { name: "New workspace" }));
    const dialog = await screen.findByRole("dialog", { name: "New workspace" });
    const name = within(dialog).getByLabelText("Name");
    expect(name).toHaveFocus();

    await user.type(name, "Café Crème: Señor's guide");
    expect(within(dialog).getByTestId("slug-preview")).toHaveTextContent(
      "cafe-creme-senor-s-guide",
    );

    await user.type(within(dialog).getByLabelText(/description/i), "  Coffee shorts  ");
    await user.click(within(dialog).getByRole("button", { name: "Create workspace" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(posted).toEqual([{ name: "Café Crème: Señor's guide", description: "Coffee shorts" }]);
    expect(db.workspaces[0]?.slug).toBe("cafe-creme-senor-s-guide");

    await waitFor(() => expect(router.state.location.pathname).toBe("/w/cafe-creme-senor-s-guide"));
    expect(
      await screen.findByRole("heading", { name: "Café Crème: Señor's guide", level: 1 }),
    ).toBeInTheDocument();
    expect(await screen.findByText("Workspace created")).toBeInTheDocument();
  });

  it("requires a name and shows API errors inline", async () => {
    const { user } = renderApp("/workspaces", signedInDb(), [
      http.post("*/api/workspaces", () =>
        HttpResponse.json(
          { error: { code: "conflict", message: "A workspace with that slug already exists." } },
          { status: 409 },
        ),
      ),
    ]);

    await user.click(await screen.findByRole("button", { name: "New workspace" }));
    const dialog = await screen.findByRole("dialog", { name: "New workspace" });

    await user.click(within(dialog).getByRole("button", { name: "Create workspace" }));
    expect(within(dialog).getByText("Give the workspace a name.")).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Name")).toHaveAttribute("aria-invalid", "true");

    await user.type(within(dialog).getByLabelText("Name"), "Rust in 60 seconds{Enter}");
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("already exists");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});
