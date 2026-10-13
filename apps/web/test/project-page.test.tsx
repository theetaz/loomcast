import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { activeTabFor, projectTabs } from "@/features/project/tabs/registry";
import { mockConversation } from "@/mocks/conversations";
import { MOCK_USER } from "@/mocks/db";
import { kbSetup, PROJECT_SLUG, recordRequests } from "./support/kb";
import { fakeStream } from "./support/live";
import { renderApp } from "./support/render";

const PROJECT_PATH = `/projects/${PROJECT_SLUG}`;

function renderProject(db: ReturnType<typeof kbSetup>["db"], path = PROJECT_PATH) {
  const stream = fakeStream(db);
  return renderApp(path, db, [], { createEventSource: stream.factory });
}

describe("project tab registry", () => {
  it("loads the tab files in order", () => {
    expect(projectTabs.map((tab) => [tab.id, tab.label, tab.to])).toEqual([
      ["overview", "Overview", "/projects/$projectId"],
      ["content", "Content", "/projects/$projectId/content"],
      ["series", "Series", "/projects/$projectId/series"],
      ["chat", "Chat", "/projects/$projectId/chat"],
      ["knowledge", "Knowledge", "/projects/$projectId/kb"],
    ]);
  });

  it("activates the tab whose path is the longest prefix", () => {
    const active = (pathname: string) => activeTabFor(projectTabs, pathname, "/projects/demo")?.id;
    expect(active("/projects/demo")).toBe("overview");
    expect(active("/projects/demo/")).toBe("overview");
    expect(active("/projects/demo/chat")).toBe("chat");
    expect(active("/projects/demo/kb/new")).toBe("knowledge");
    expect(active("/projects/demo/kbx")).toBe("overview");
    expect(active("/projects/other")).toBeUndefined();
  });
});

describe("project page", () => {
  it("opens on the overview and switches tabs by route", async () => {
    const { db } = kbSetup();
    const { user, router } = renderProject(db);

    const tabs = await screen.findByRole("tablist", { name: "Project sections" });
    expect(
      within(tabs)
        .getAllByRole("tab")
        .map((tab) => tab.textContent),
    ).toEqual(["Overview", "Content", "Series", "Chat", "Knowledge"]);
    expect(within(tabs).getByRole("tab", { name: "Overview" })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    await user.click(within(tabs).getByRole("tab", { name: "Knowledge" }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`${PROJECT_PATH}/kb`));
    expect(await screen.findByRole("list", { name: "All entries" })).toBeInTheDocument();

    // Pages below a tab keep it active.
    await user.click(screen.getByRole("link", { name: /Recording checklist/ }));
    await screen.findByLabelText("Title");
    expect(within(tabs).getByRole("tab", { name: "Knowledge" })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    // Keyboard: arrows move between tabs and open them.
    within(tabs).getByRole("tab", { name: "Knowledge" }).focus();
    await user.keyboard("{ArrowLeft}");
    await waitFor(() => expect(router.state.location.pathname).toBe(`${PROJECT_PATH}/chat`));
    expect(await screen.findByRole("region", { name: /Conversations in/ })).toBeInTheDocument();
  });

  it("sends a conversation link to the Chat tab", async () => {
    const { db, project } = kbSetup();
    const conversation = mockConversation({
      projectId: project.id,
      createdBy: MOCK_USER.id,
      title: "Ownership",
    });
    db.conversations.push(conversation);
    const { router } = renderProject(db, `${PROJECT_PATH}?conversation=${conversation.id}`);

    await waitFor(() => expect(router.state.location.pathname).toBe(`${PROJECT_PATH}/chat`));
    expect(router.state.location.search).toEqual({ conversation: conversation.id });
  });

  it("shows stats, recent knowledge and recent conversations", async () => {
    const { db, project } = kbSetup();
    db.conversations.push(
      mockConversation({ projectId: project.id, createdBy: MOCK_USER.id, title: "Series ideas" }),
    );
    renderProject(db);

    const stats = await screen.findByLabelText("Project stats");
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
    const { db, project } = kbSetup();
    const requests = recordRequests();
    const { user } = renderProject(db);

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
    expect(db.projects.find((item) => item.id === project.id)?.description).toBe(
      "Short Rust lessons",
    );
    expect(screen.getByRole("button", { name: "Edit description" })).toHaveFocus();
  });

  it("archives after confirming", async () => {
    const { db, project } = kbSetup();
    const { user } = renderProject(db);

    await user.click(await screen.findByRole("button", { name: "Archive project" }));
    const dialog = await screen.findByRole("alertdialog", { name: `Archive ${project.name}?` });
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(db.projects[0]?.status).toBe("active");

    await user.click(screen.getByRole("button", { name: "Archive project" }));
    const again = await screen.findByRole("alertdialog");
    await user.click(within(again).getByRole("button", { name: "Archive project" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(db.projects[0]?.status).toBe("archived");
    expect(
      await screen.findByText("Archived", { selector: "[data-slot=badge]" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Archive project" })).not.toBeInTheDocument();
  });
});
