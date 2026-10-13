import { MCP_TOKEN_RE } from "@loomcast/contracts";
import type { QueryClient } from "@tanstack/react-query";
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TOKEN_PLACEHOLDER } from "@/features/settings/McpConfigSnippet";
import { createMockDb, MOCK_USER, mockToken, mockTokenSecret, tokenPrefix } from "@/mocks/db";
import { renderApp } from "./support/render";
import { server } from "./support/server";

function signedInDb(tokens = defaultTokens(), role: "owner" | "admin" = "owner") {
  return createMockDb({ signedIn: true, user: { ...MOCK_USER, role }, tokens });
}

/** Generated per run, so no token-shaped literal lives in the tests. */
const LISTED_PREFIX = tokenPrefix(mockTokenSecret());

function defaultTokens() {
  return [
    mockToken({
      name: "Editor on my laptop",
      prefix: LISTED_PREFIX,
      scopes: ["mcp:read", "mcp:write"],
      createdAt: "2026-10-05T09:00:00.000Z",
      lastUsedAt: "2026-10-12T09:00:00.000Z",
    }),
    mockToken({
      name: "Revoked one",
      scopes: ["mcp:read"],
      revokedAt: "2026-10-06T09:00:00.000Z",
    }),
    mockToken({ name: "Studio Mac mini", kind: "device", scopes: ["bridge"] }),
  ];
}

/** Everything TanStack Query holds: query data and mutation state. */
function cacheContents(queryClient: QueryClient): string {
  return JSON.stringify({
    queries: queryClient
      .getQueryCache()
      .getAll()
      .map((query) => query.state),
    mutations: queryClient
      .getMutationCache()
      .getAll()
      .map((mutation) => mutation.state),
  });
}

describe("access tokens list", () => {
  it("lists working MCP tokens with prefix, scopes and last use", async () => {
    renderApp("/settings/tokens", signedInDb());

    const table = await screen.findByRole("table", { name: "Access tokens" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(1);
    const row = rows[0] as HTMLElement;
    expect(row).toHaveTextContent("Editor on my laptop");
    expect(row).toHaveTextContent(`${LISTED_PREFIX}…`);
    expect(within(row).getByText("Read")).toBeInTheDocument();
    expect(within(row).getByText("Write")).toBeInTheDocument();
    expect(row.querySelectorAll("time")[0]).toHaveAttribute("datetime", "2026-10-12T09:00:00.000Z");
  });

  it("shows an empty state and the MCP client example with placeholders", async () => {
    renderApp("/settings/tokens", signedInDb([]));

    expect(await screen.findByText("No access tokens")).toBeInTheDocument();
    const example = screen.getByRole("region", { name: "Connect an MCP client" });
    const config = within(example).getByText(/"mcpServers"/);
    expect(config.textContent).toContain(`"url": "${window.location.origin}/mcp"`);
    expect(config.textContent).toContain(`"Authorization": "Bearer ${TOKEN_PLACEHOLDER}"`);
  });

  it("revokes a token after confirming", async () => {
    const db = signedInDb();
    const { user } = renderApp("/settings/tokens", db);

    await user.click(await screen.findByRole("button", { name: "Revoke Editor on my laptop" }));
    const confirm = await screen.findByRole("alertdialog", {
      name: "Revoke Editor on my laptop?",
    });
    await user.click(within(confirm).getByRole("button", { name: "Revoke token" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(db.tokens[0]?.revokedAt).not.toBeNull();
    expect(await screen.findByText("No access tokens")).toBeInTheDocument();
  });
});

describe("new token dialog", () => {
  it("shows the secret once and keeps it out of every cache after closing", async () => {
    const db = signedInDb([]);
    const posted: unknown[] = [];
    server.events.on("request:start", async ({ request }) => {
      if (request.method === "POST" && new URL(request.url).pathname === "/api/tokens") {
        posted.push(await request.clone().json());
      }
    });
    const { user, queryClient } = renderApp("/settings/tokens", db);

    await user.click(
      (await screen.findAllByRole("button", { name: "New token" }))[0] as HTMLElement,
    );
    const dialog = await screen.findByRole("dialog", { name: "New access token" });
    expect(within(dialog).getByRole("switch", { name: /^Read/ })).toBeChecked();
    expect(within(dialog).getByRole("switch", { name: /^Admin/ })).not.toBeChecked();

    await user.type(within(dialog).getByLabelText("Name"), "Laptop scripts");
    await user.click(within(dialog).getByRole("switch", { name: /^Write/ }));
    await user.click(within(dialog).getByRole("button", { name: "Create token" }));

    const reveal = await screen.findByRole("dialog", { name: "Copy your new token" });
    expect(posted).toEqual([{ name: "Laptop scripts", scopes: ["mcp:read", "mcp:write"] }]);
    const secret = within(reveal).getByTestId("token-secret").textContent ?? "";
    expect(secret).toMatch(MCP_TOKEN_RE);
    expect(secret.startsWith(db.tokens[0]?.prefix ?? "?")).toBe(true);
    expect(within(reveal).getByText("This is the only time it's shown.")).toBeInTheDocument();

    await user.click(within(reveal).getByRole("button", { name: /copy token/i }));
    expect(await navigator.clipboard.readText()).toBe(secret);

    // Even while the reveal is open, the secret is in no query or mutation cache.
    await waitFor(() => expect(cacheContents(queryClient)).not.toContain(secret));

    await user.click(within(reveal).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(document.body.textContent).not.toContain(secret);
    expect(cacheContents(queryClient)).not.toContain(secret);

    // The list shows the new token by its prefix only.
    const table = await screen.findByRole("table", { name: "Access tokens" });
    const row = within(table).getByText("Laptop scripts").closest("tr") as HTMLElement;
    expect(row).toHaveTextContent(`${db.tokens[0]?.prefix}…`);

    // Opening again starts over: an empty form, no secret.
    await user.click(screen.getByRole("button", { name: "New token" }));
    const again = await screen.findByRole("dialog", { name: "New access token" });
    expect(within(again).getByLabelText("Name")).toHaveValue("");
    expect(document.body.textContent).not.toContain(secret);
  });

  it("offers the admin scope only to the owner", async () => {
    const { user } = renderApp("/settings/tokens", signedInDb([], "admin"));

    await user.click(
      (await screen.findAllByRole("button", { name: "New token" }))[0] as HTMLElement,
    );
    const dialog = await screen.findByRole("dialog", { name: "New access token" });
    expect(within(dialog).getAllByRole("switch")).toHaveLength(2);
    expect(within(dialog).queryByRole("switch", { name: /^Admin/ })).not.toBeInTheDocument();
  });

  it("asks for a name and at least one scope", async () => {
    const db = signedInDb([]);
    const { user } = renderApp("/settings/tokens", db);

    await user.click(
      (await screen.findAllByRole("button", { name: "New token" }))[0] as HTMLElement,
    );
    const dialog = await screen.findByRole("dialog", { name: "New access token" });

    await user.click(within(dialog).getByRole("button", { name: "Create token" }));
    expect(
      within(dialog).getByText("Name the token after the tool that will use it."),
    ).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Name")).toHaveFocus();

    await user.type(within(dialog).getByLabelText("Name"), "Laptop scripts");
    await user.click(within(dialog).getByRole("switch", { name: /^Read/ }));
    await user.click(within(dialog).getByRole("button", { name: "Create token" }));
    expect(within(dialog).getByText("Pick at least one scope.")).toBeInTheDocument();
    expect(db.tokens).toHaveLength(0);
  });
});
