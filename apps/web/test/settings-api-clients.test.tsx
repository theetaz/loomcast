import { API_KEY_RE } from "@loomcast/contracts";
import type { QueryClient } from "@tanstack/react-query";
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { apiKeyPrefix, mockApiClient, mockApiKey } from "@/mocks/api-clients";
import { mockChannel } from "@/mocks/calendar";
import { createMockDb, MOCK_USER, mockWorkspace } from "@/mocks/db";
import { renderApp } from "./support/render";
import { server } from "./support/server";

const workspace = mockWorkspace({ name: "Release notes", slug: "release-notes" });
const other = mockWorkspace({ name: "Side project", slug: "side-project" });
const PATH = `/w/${workspace.slug}/settings/api-clients`;
const facebook = mockChannel({
  workspaceId: workspace.id,
  platform: "facebook",
  displayName: "Loomcast Page",
});
const instagram = mockChannel({
  workspaceId: workspace.id,
  platform: "instagram",
  displayName: "loomcast.dev",
});
const elsewhere = mockChannel({
  workspaceId: other.id,
  platform: "threads",
  displayName: "side.threads",
});

function setup(role: "owner" | "admin" = "owner") {
  const listed = mockApiClient({
    name: "Blog backend",
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    prefix: apiKeyPrefix(mockApiKey()),
    lastUsedAt: "2026-10-12T09:00:00.000Z",
    grants: [
      {
        channelId: facebook.id,
        access: "publish",
        platform: "facebook",
        channelName: facebook.displayName,
      },
      {
        channelId: instagram.id,
        access: "read",
        platform: "instagram",
        channelName: instagram.displayName,
      },
    ],
  });
  const revoked = mockApiClient({
    name: "Old cron job",
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    revokedAt: "2026-10-01T09:00:00.000Z",
  });
  // Another workspace's client never shows in this workspace's settings.
  const foreign = mockApiClient({
    name: "Side backend",
    workspaceId: other.id,
    workspaceName: other.name,
  });
  const db = createMockDb({
    signedIn: true,
    user: { ...MOCK_USER, role },
    workspaces: [workspace, other],
    channels: [facebook, instagram, elsewhere],
    apiClients: [listed, revoked, foreign],
  });
  return { db, listed, revoked };
}

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

function recordBodies(method: string, pathname: RegExp) {
  const bodies: unknown[] = [];
  server.events.on("request:start", async ({ request }) => {
    if (request.method === method && pathname.test(new URL(request.url).pathname)) {
      bodies.push(await request.clone().json());
    }
  });
  return bodies;
}

describe("API clients list", () => {
  it("lists the workspace's clients with their channel access, last use and status", async () => {
    const { db, listed } = setup();
    renderApp(PATH, db);

    const table = await screen.findByRole("table", { name: "API clients" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    expect(table).not.toHaveTextContent("Side backend");
    const row = rows[0] as HTMLElement;
    expect(row).toHaveTextContent("Blog backend");
    expect(row).toHaveTextContent(`${listed.prefix}…`);
    const channels = within(row).getByRole("list", { name: "Channels of Blog backend" });
    expect(channels).toHaveTextContent("Loomcast Page· Publish");
    expect(channels).toHaveTextContent("loomcast.dev· Read");
    expect(row).toHaveTextContent("Active");
    expect(row.querySelector("time")).toHaveAttribute("datetime", "2026-10-12T09:00:00.000Z");

    // A revoked client stays listed, without actions.
    const old = rows[1] as HTMLElement;
    expect(old).toHaveTextContent("Revoked");
    expect(within(old).queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Connect a backend" })).toHaveTextContent(
      `${window.location.origin}/api/v1/channels`,
    );
  });

  it("revokes a client after confirming", async () => {
    const { db, listed } = setup();
    const { user } = renderApp(PATH, db);

    await user.click(await screen.findByRole("button", { name: "Revoke Blog backend" }));
    const confirm = await screen.findByRole("alertdialog", { name: "Revoke Blog backend?" });
    await user.click(within(confirm).getByRole("button", { name: "Revoke client" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(db.apiClients.find((client) => client.id === listed.id)?.revokedAt).not.toBeNull();
  });

  it("is for the owner only", async () => {
    const { db } = setup("admin");
    renderApp(PATH, db);
    expect(await screen.findByText("Only the owner manages API clients")).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "API clients" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /API clients/ })).not.toBeInTheDocument();
  });
});

describe("new API client dialog", () => {
  it("creates a client in the open workspace with channel levels, then shows the key once", async () => {
    const { db } = setup();
    db.apiClients = [];
    const posted = recordBodies("POST", /^\/api\/api-clients$/);
    const { user, queryClient } = renderApp(PATH, db);

    await user.click(
      (await screen.findAllByRole("button", { name: "New client" }))[0] as HTMLElement,
    );
    const dialog = await screen.findByRole("dialog", { name: "New API client" });
    await user.type(within(dialog).getByLabelText("Name"), "Shop backend");

    // The client posts into the open workspace; only its channels can be granted.
    expect(within(dialog).queryByRole("combobox", { name: "Workspace" })).not.toBeInTheDocument();
    // Every channel starts without access.
    const onPage = await within(dialog).findByRole("combobox", {
      name: "Access to Loomcast Page (Facebook)",
    });
    expect(within(dialog).queryByText("side.threads")).not.toBeInTheDocument();
    expect(onPage).toHaveTextContent("No access");
    await user.click(onPage);
    await user.click(await screen.findByRole("option", { name: "Publish" }));
    await user.click(
      within(dialog).getByRole("combobox", { name: "Access to loomcast.dev (Instagram)" }),
    );
    await user.click(await screen.findByRole("option", { name: "Write" }));
    await user.click(within(dialog).getByRole("button", { name: "Create client" }));

    const reveal = await screen.findByRole("dialog", { name: "Copy the API key" });
    expect(posted).toEqual([
      {
        name: "Shop backend",
        workspaceId: workspace.id,
        grants: [
          { channelId: facebook.id, access: "publish" },
          { channelId: instagram.id, access: "write" },
        ],
      },
    ]);
    const secret = within(reveal).getByTestId("api-key-secret").textContent ?? "";
    expect(secret).toMatch(API_KEY_RE);
    expect(secret.startsWith(db.apiClients[0]?.prefix ?? "?")).toBe(true);
    await waitFor(() => expect(cacheContents(queryClient)).not.toContain(secret));

    await user.click(within(reveal).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(document.body.textContent).not.toContain(secret);
    expect(await screen.findByRole("table", { name: "API clients" })).toHaveTextContent(
      "Shop backend",
    );
  });

  it("asks for a name and at least one channel", async () => {
    const { db } = setup();
    const { user } = renderApp(PATH, db);

    await user.click(
      (await screen.findAllByRole("button", { name: "New client" }))[0] as HTMLElement,
    );
    const dialog = await screen.findByRole("dialog", { name: "New API client" });
    await user.click(within(dialog).getByRole("button", { name: "Create client" }));
    expect(
      within(dialog).getByText("Name the client after the backend that will use it."),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText("Give the client access to at least one channel."),
    ).toBeInTheDocument();
    expect(db.apiClients).toHaveLength(3);
  });
});

describe("edit API client dialog", () => {
  it("changes the channels a client may use", async () => {
    const { db, listed } = setup();
    const patched = recordBodies("PATCH", /^\/api\/api-clients\//);
    const { user } = renderApp(PATH, db);

    await user.click(await screen.findByRole("button", { name: "Edit Blog backend" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit Blog backend" });
    expect(within(dialog).queryByRole("combobox", { name: "Workspace" })).not.toBeInTheDocument();
    const onInstagram = within(dialog).getByRole("combobox", {
      name: "Access to loomcast.dev (Instagram)",
    });
    expect(onInstagram).toHaveTextContent("Read");
    await user.click(onInstagram);
    await user.click(await screen.findByRole("option", { name: "No access" }));
    await user.click(within(dialog).getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(patched).toEqual([
      { name: "Blog backend", grants: [{ channelId: facebook.id, access: "publish" }] },
    ]);
    expect(db.apiClients.find((client) => client.id === listed.id)?.grants).toHaveLength(1);
  });
});
