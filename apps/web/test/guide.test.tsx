import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  guideBody,
  guideImageUrl,
  guideLinkTarget,
  guidePages,
  headingId,
} from "@/features/guide/pages";
import { createMockDb } from "@/mocks/db";
import { currentPath, renderApp } from "./support/render";

function signedInDb() {
  return createMockDb({ signedIn: true });
}

describe("guide pages", () => {
  it("bundles every page with its title as the first line", () => {
    expect(guidePages.length).toBeGreaterThanOrEqual(10);
    for (const page of guidePages) {
      expect(page.markdown.startsWith(`# ${page.title}\n`), page.slug).toBe(true);
    }
  });

  it("only links screenshots and guide pages that exist", () => {
    for (const page of guidePages) {
      for (const [, src] of page.markdown.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) {
        expect(guideImageUrl(src ?? ""), `${page.slug}: ${src}`).toBeDefined();
      }
      for (const [, href] of page.markdown.matchAll(
        /(?<!!)\[[^\]]*\]\(([\w-]+\.md(?:#[\w-]+)?)\)/g,
      )) {
        expect(guideLinkTarget(href ?? ""), `${page.slug}: ${href}`).toBeDefined();
      }
    }
  });

  // The repository is public: the guide must not leak the deployment or anyone's accounts.
  it("keeps private details out of the text", () => {
    const patterns: [string, RegExp][] = [
      ["an IP address", /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/],
      ["a uuid", /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i],
      ["a home directory", /\/(?:Users|home)\/[\w.-]+/],
      ["a device token", /\blc_(?:dev|mcp|job|api)_\w{8,}/],
      ["the production domain", /prabhavalabs/i],
      ["an email address", /[\w.+-]+@(?!example\.com\b|loomcast\.test\b)[\w-]+\.[\w.]+/],
    ];
    for (const page of guidePages) {
      for (const [label, pattern] of patterns) {
        expect(pattern.test(page.markdown), `${page.slug} contains ${label}`).toBe(false);
      }
    }
  });

  it("resolves screenshots and links only within the guide", () => {
    expect(guideImageUrl("images/../secret.png")).toBeUndefined();
    expect(guideImageUrl("https://example.com/image.png")).toBeUndefined();
    expect(guideImageUrl("images/missing.png")).toBeUndefined();
    expect(guideLinkTarget("studio-agent.md#pair-the-mac")).toEqual({
      slug: "studio-agent",
      hash: "pair-the-mac",
    });
    expect(guideLinkTarget("missing.md")).toBeUndefined();
    expect(guideLinkTarget("https://example.com/studio-agent.md")).toBeUndefined();
    expect(guideBody("# Title\n\nBody")).toBe("Body");
    expect(headingId("What to start and stop")).toBe("what-to-start-and-stop");
  });

  it("opens the guide from the sidebar and moves between pages", async () => {
    const { user, router } = renderApp("/", signedInDb());

    const nav = await screen.findByRole("navigation", { name: "Workspace" });
    await user.click(within(nav).getByRole("link", { name: "Guide" }));
    expect(await screen.findByRole("heading", { name: "Guide", level: 1 })).toBeInTheDocument();

    const first = guidePages[0];
    const second = guidePages[1];
    if (!first || !second) throw new Error("the guide has pages");
    await user.click(screen.getByRole("link", { name: new RegExp(first.title) }));
    expect(await screen.findByRole("heading", { name: first.title, level: 1 })).toBeInTheDocument();
    expect(currentPath(router)).toBe(`/guide/${first.slug}`);

    const more = screen.getByRole("navigation", { name: "More guide pages" });
    await user.click(within(more).getByRole("link", { name: second.title }));
    expect(
      await screen.findByRole("heading", { name: second.title, level: 1 }),
    ).toBeInTheDocument();
  });

  it("explains an unknown page", async () => {
    renderApp("/guide/missing", signedInDb());
    expect(await screen.findByText("No such guide page")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "All guide pages" })).toHaveAttribute("href", "/guide");
  });
});
