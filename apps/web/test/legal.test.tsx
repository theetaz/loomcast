import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LEGAL_CONTACT_EMAIL } from "@/features/legal/contact";
import { createMockDb } from "@/mocks/db";
import { currentPath, renderApp } from "./support/render";
import { server } from "./support/server";

const PAGES = [
  { path: "/privacy", heading: "Privacy policy" },
  { path: "/terms", heading: "Terms of service" },
  { path: "/data-deletion", heading: "Data deletion" },
] as const;

describe("legal pages", () => {
  it.each(PAGES)(
    "renders $path signed out, without redirecting or calling the API",
    async ({ path, heading }) => {
      const apiCalls: string[] = [];
      server.events.on("request:start", ({ request }) => {
        apiCalls.push(new URL(request.url).pathname);
      });
      const db = createMockDb();
      const { router } = renderApp(path, db);

      expect(await screen.findByRole("heading", { name: heading, level: 1 })).toBeInTheDocument();
      expect(currentPath(router)).toBe(path);
      expect(db.signedIn).toBe(false);
      expect(apiCalls).toEqual([]);
      expect(screen.getByText("13 October 2026")).toHaveAttribute("datetime", "2026-10-13");
      expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/login");

      const nav = screen.getByRole("navigation", { name: "Legal pages" });
      for (const page of PAGES) {
        expect(within(nav).getByRole("link", { name: page.heading })).toHaveAttribute(
          "href",
          page.path,
        );
      }
      expect(within(nav).getByRole("link", { name: heading })).toHaveAttribute(
        "aria-current",
        "page",
      );
      for (const link of screen.getAllByRole("link", { name: LEGAL_CONTACT_EMAIL })) {
        expect(link).toHaveAttribute("href", `mailto:${LEGAL_CONTACT_EMAIL}`);
      }
    },
  );

  it("explains every way to request deletion and the deadline", async () => {
    renderApp("/data-deletion", createMockDb());

    expect(await screen.findByText("Settings → Channels")).toBeInTheDocument();
    expect(screen.getByText(/Business integrations/)).toBeInTheDocument();
    expect(screen.getByText(/Website permissions/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "3. Ask us to delete your data" })).toBeVisible();
    expect(screen.getByText(/within 30 days of the request being confirmed/)).toBeInTheDocument();
  });

  it("moves between the legal pages and on to sign in", async () => {
    const { user, router } = renderApp("/privacy", createMockDb());

    const nav = await screen.findByRole("navigation", { name: "Legal pages" });
    await user.click(within(nav).getByRole("link", { name: "Terms of service" }));
    expect(
      await screen.findByRole("heading", { name: "Terms of service", level: 1 }),
    ).toBeInTheDocument();
    expect(currentPath(router)).toBe("/terms");

    await user.click(screen.getByRole("link", { name: "Sign in" }));
    expect(await screen.findByRole("heading", { name: "Sign in to Loomcast" })).toBeInTheDocument();
  });

  it("links to the privacy policy and terms from the login page", async () => {
    const { user, router } = renderApp("/login", createMockDb());

    const legal = await screen.findByRole("navigation", { name: "Legal" });
    expect(within(legal).getByRole("link", { name: "Privacy" })).toHaveAttribute(
      "href",
      "/privacy",
    );
    expect(within(legal).getByRole("link", { name: "Terms" })).toHaveAttribute("href", "/terms");

    await user.click(within(legal).getByRole("link", { name: "Privacy" }));
    expect(
      await screen.findByRole("heading", { name: "Privacy policy", level: 1 }),
    ).toBeInTheDocument();
    expect(currentPath(router)).toBe("/privacy");
  });
});
