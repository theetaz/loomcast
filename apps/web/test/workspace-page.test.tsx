import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { mockChannel } from "@/mocks/calendar";
import { mockConversation } from "@/mocks/conversations";
import { MOCK_USER, mockWorkspace } from "@/mocks/db";
import { kbSetup, recordRequests, WORKSPACE_SLUG } from "./support/kb";
import { fakeStream } from "./support/live";
import { renderApp } from "./support/render";

const WORKSPACE_PATH = `/w/${WORKSPACE_SLUG}`;

function renderWorkspace(db: ReturnType<typeof kbSetup>["db"], path = WORKSPACE_PATH) {
  const stream = fakeStream(db);
  return renderApp(path, db, [], { createEventSource: stream.factory });
}

describe("workspace overview", () => {
  it("opens on the overview and links into the workspace's pages", async () => {
    const { db } = kbSetup();
    const { user, router } = renderWorkspace(db);

    expect(
      await screen.findByRole("heading", { name: "Rust in 60 seconds", level: 1 }),
    ).toBeInTheDocument();
    // The old tab bar is gone: the sidebar and the cards lead to the pages.
    expect(screen.queryByRole("tablist", { name: "Workspace sections" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Settings" })).toHaveAttribute(
      "href",
      `${WORKSPACE_PATH}/settings`,
    );

    await user.click(screen.getByRole("link", { name: /Open knowledge/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`${WORKSPACE_PATH}/kb`));
    expect(await screen.findByRole("list", { name: "All entries" })).toBeInTheDocument();
  });

  it("swaps an id in the address for the slug and keeps the rest", async () => {
    const { db, workspace } = kbSetup();
    const { router } = renderWorkspace(db, `/w/${workspace.id}/kb?kind=note`);

    await waitFor(() => expect(router.state.location.pathname).toBe(`${WORKSPACE_PATH}/kb`));
    expect(router.state.location.search).toEqual({ kind: "note" });
    expect(await screen.findByRole("list", { name: /entries/i })).toBeInTheDocument();
  });

  it("says when the workspace doesn't exist", async () => {
    const { db } = kbSetup();
    renderWorkspace(db, "/w/no-such-workspace");

    expect(
      await screen.findByRole("heading", { name: "Workspace not found", level: 1 }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "All workspaces" })).toHaveAttribute(
      "href",
      "/workspaces",
    );
  });

  it("summarises the workspace's own channels", async () => {
    const { db, workspace } = kbSetup();
    const other = mockWorkspace({ name: "Agents for small teams", slug: "agents" });
    db.workspaces.push(other);
    const page = mockChannel({
      workspaceId: workspace.id,
      platform: "facebook",
      displayName: "Rust Page",
      connected: true,
      status: "active",
    });
    db.channels.push(
      page,
      mockChannel({ workspaceId: other.id, platform: "instagram", displayName: "@agents" }),
    );
    renderWorkspace(db);

    const channels = await screen.findByRole("list", { name: "Workspace channels" });
    expect(
      within(channels)
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual([expect.stringContaining("Rust Page")]);
    expect(within(channels).getByRole("link", { name: /Rust Page/ })).toHaveAttribute(
      "href",
      `${WORKSPACE_PATH}/calendar?channels=${page.id}`,
    );
  });

  it("sends a conversation link to Chat", async () => {
    const { db, workspace } = kbSetup();
    const conversation = mockConversation({
      workspaceId: workspace.id,
      createdBy: MOCK_USER.id,
      title: "Ownership",
    });
    db.conversations.push(conversation);
    const { router } = renderWorkspace(db, `${WORKSPACE_PATH}?conversation=${conversation.id}`);

    await waitFor(() => expect(router.state.location.pathname).toBe(`${WORKSPACE_PATH}/chat`));
    expect(router.state.location.search).toEqual({ conversation: conversation.id });
  });

  it("shows stats, recent knowledge and recent conversations", async () => {
    const { db, workspace } = kbSetup();
    db.conversations.push(
      mockConversation({
        workspaceId: workspace.id,
        createdBy: MOCK_USER.id,
        title: "Series ideas",
      }),
    );
    renderWorkspace(db);

    const stats = await screen.findByLabelText("Workspace stats");
    await waitFor(() =>
      expect(within(stats).getByText("Knowledge entries").nextSibling).toHaveTextContent("4"),
    );
    expect(within(stats).getByText("Conversations").nextSibling).toHaveTextContent("1");
    expect(within(stats).getByText("Tags").nextSibling).toHaveTextContent("3");

    const recent = await screen.findByRole("list", { name: "Recent knowledge" });
    expect(within(recent).getAllByRole("link")[0]).toHaveTextContent(
      "Hooks that open on the error",
    );
    const conversations = await screen.findByRole("list", { name: "Recent conversations" });
    expect(within(conversations).getByRole("link", { name: /Series ideas/ })).toHaveAttribute(
      "href",
      expect.stringMatching(/\/chat\?conversation=/),
    );
  });

  it("edits the description inline", async () => {
    const { db, workspace } = kbSetup();
    const requests = recordRequests();
    const { user } = renderWorkspace(db);

    await user.click(await screen.findByRole("button", { name: "Edit description" }));
    const field = screen.getByRole("textbox", { name: "Description" });
    expect(field).toHaveFocus();
    await user.clear(field);
    await user.type(field, "Short Rust lessons");
    await user.keyboard("{Escape}");
    expect(screen.getByText("One Rust idea per short.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Edit description" }));
    await user.clear(screen.getByRole("textbox", { name: "Description" }));
    await user.type(screen.getByRole("textbox", { name: "Description" }), "  Short Rust lessons ");
    await user.keyboard("{Meta>}{Enter}{/Meta}");

    expect(await screen.findByText("Short Rust lessons")).toBeInTheDocument();
    expect(requests.find((request) => request.method === "PATCH")?.body).toEqual({
      description: "Short Rust lessons",
    });
    expect(db.workspaces.find((item) => item.id === workspace.id)?.description).toBe(
      "Short Rust lessons",
    );
    expect(screen.getByRole("button", { name: "Edit description" })).toHaveFocus();
  });

  it("archives from the workspace settings after confirming", async () => {
    const { db, workspace } = kbSetup();
    const { user } = renderWorkspace(db, `${WORKSPACE_PATH}/settings`);

    await user.click(await screen.findByRole("button", { name: "Archive workspace" }));
    const dialog = await screen.findByRole("alertdialog", { name: `Archive ${workspace.name}?` });
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(db.workspaces[0]?.status).toBe("active");

    await user.click(screen.getByRole("button", { name: "Archive workspace" }));
    const again = await screen.findByRole("alertdialog");
    await user.click(within(again).getByRole("button", { name: "Archive workspace" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(db.workspaces[0]?.status).toBe("archived");
    expect(await screen.findByRole("region", { name: "Archive" })).toHaveTextContent(/^Archived/);
    expect(screen.queryByRole("button", { name: "Archive workspace" })).not.toBeInTheDocument();
  });
});
