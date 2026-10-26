import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createMockDb } from "@/mocks/db";
import { currentPath, renderApp } from "./support/render";

describe("auth guard", () => {
  it("redirects to login with next when /api/auth/me answers 401", async () => {
    const { router } = renderApp("/workspaces?status=archived", createMockDb());

    expect(await screen.findByRole("heading", { name: "Sign in to Loomcast" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/login");
    expect(router.state.location.search).toEqual({ next: "/workspaces?status=archived" });
  });

  it("sends the user to login when the session ends mid-use", async () => {
    const db = createMockDb({ signedIn: true });
    const { router } = renderApp("/workspaces", db);
    expect(
      await screen.findByRole("heading", { name: "Workspaces", level: 1 }),
    ).toBeInTheDocument();

    // The session expires; the next request answers 401.
    db.signedIn = false;
    await router.options.context.queryClient.refetchQueries();

    await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
    expect(router.state.location.search).toEqual({ next: "/workspaces" });
  });

  it("shows the shell for a signed-in user", async () => {
    const { router } = renderApp("/", createMockDb({ signedIn: true }));

    expect(await screen.findByRole("navigation", { name: "Breadcrumb" })).toHaveTextContent(
      "Workspaces",
    );
    expect(screen.getByText("owner@loomcast.test")).toBeInTheDocument();
    expect(currentPath(router)).toBe("/workspaces");
  });

  it("renders the 404 page inside the shell", async () => {
    renderApp("/no/such/page", createMockDb({ signedIn: true }));

    expect(
      await screen.findByRole("heading", { name: "This page doesn't exist" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /back to home/i })).toBeInTheDocument();
  });
});
