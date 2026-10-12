import { screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { createMockDb, mockProject } from "@/mocks/db";
import { renderApp } from "./support/render";
import { server } from "./support/server";

function signedInDb(
  projects = [
    mockProject({
      name: "Rust in 60 seconds",
      slug: "rust-in-60-seconds",
      updatedAt: "2026-10-12T09:00:00.000Z",
    }),
    mockProject({
      name: "Agents for small teams",
      slug: "agents-for-small-teams",
      updatedAt: "2026-10-11T09:00:00.000Z",
    }),
    mockProject({
      name: "Shell one-liners",
      slug: "shell-one-liners",
      status: "archived",
      updatedAt: "2026-10-01T09:00:00.000Z",
    }),
  ],
) {
  return createMockDb({ signedIn: true, projects });
}

describe("projects list", () => {
  it("renders active projects with slug and age, newest first", async () => {
    renderApp("/projects", signedInDb());

    const list = await screen.findByRole("list", { name: "Active projects" });
    const rows = within(list).getAllByRole("link");
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("Rust in 60 seconds"),
      expect.stringContaining("Agents for small teams"),
    ]);
    expect(within(rows[0] as HTMLElement).getByText("rust-in-60-seconds")).toBeInTheDocument();
    expect(rows[0]?.querySelector("time")).toHaveAttribute("datetime", "2026-10-12T09:00:00.000Z");
    expect(rows[0]).toHaveAttribute("href", expect.stringMatching(/^\/projects\/[0-9a-f-]{36}$/));
  });

  it("filters archived projects from the tabs", async () => {
    const { user, router } = renderApp("/projects", signedInDb());

    await user.click(await screen.findByRole("tab", { name: /archived/i }));

    const list = await screen.findByRole("list", { name: "Archived projects" });
    expect(within(list).getByText("Shell one-liners")).toBeInTheDocument();
    expect(router.state.location.search).toEqual({ status: "archived" });
  });

  it("shows an empty state with a way to start", async () => {
    renderApp("/projects", signedInDb([]));

    expect(await screen.findByText("No projects yet")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "New project" })).toHaveLength(2);
  });

  it("shows the error and retries", async () => {
    let fail = true;
    const { user } = renderApp("/projects", signedInDb(), [
      http.get("*/api/projects", () =>
        fail
          ? HttpResponse.json({ error: { code: "internal", message: "Boom" } }, { status: 500 })
          : HttpResponse.json({ items: [] }),
      ),
    ]);

    expect(await screen.findByText("Couldn't load projects")).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole("button", { name: /try again/i }));
    expect(await screen.findByText("No projects yet")).toBeInTheDocument();
  });
});

describe("new project dialog", () => {
  it("previews the slug, calls the API and adds the project to the list", async () => {
    const db = signedInDb();
    const posted: unknown[] = [];
    server.events.on("request:start", async ({ request }) => {
      if (request.method === "POST" && new URL(request.url).pathname === "/api/projects") {
        posted.push(await request.clone().json());
      }
    });
    const { user } = renderApp("/projects", db);

    await user.click(await screen.findByRole("button", { name: "New project" }));
    const dialog = await screen.findByRole("dialog", { name: "New project" });
    const name = within(dialog).getByLabelText("Name");
    expect(name).toHaveFocus();

    await user.type(name, "Café Crème: Señor's guide");
    expect(within(dialog).getByTestId("slug-preview")).toHaveTextContent(
      "cafe-creme-senor-s-guide",
    );

    await user.type(within(dialog).getByLabelText(/description/i), "  Coffee shorts  ");
    await user.click(within(dialog).getByRole("button", { name: "Create project" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(posted).toEqual([{ name: "Café Crème: Señor's guide", description: "Coffee shorts" }]);
    expect(db.projects[0]?.slug).toBe("cafe-creme-senor-s-guide");

    const list = screen.getByRole("list", { name: "Active projects" });
    expect(within(list).getAllByRole("link")[0]).toHaveTextContent("Café Crème: Señor's guide");
    expect(await screen.findByText("Project created")).toBeInTheDocument();
  });

  it("requires a name and shows API errors inline", async () => {
    const { user } = renderApp("/projects", signedInDb(), [
      http.post("*/api/projects", () =>
        HttpResponse.json(
          { error: { code: "conflict", message: "A project with that slug already exists." } },
          { status: 409 },
        ),
      ),
    ]);

    await user.click(await screen.findByRole("button", { name: "New project" }));
    const dialog = await screen.findByRole("dialog", { name: "New project" });

    await user.click(within(dialog).getByRole("button", { name: "Create project" }));
    expect(within(dialog).getByText("Give the project a name.")).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Name")).toHaveAttribute("aria-invalid", "true");

    await user.type(within(dialog).getByLabelText("Name"), "Rust in 60 seconds{Enter}");
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("already exists");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});
