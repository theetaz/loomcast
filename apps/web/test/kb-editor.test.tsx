import type { DecisionData } from "@loomcast/contracts";
import { act, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { draftKey } from "@/features/kb/draft";
import { updateKbEntry } from "@/mocks/kb";
import { kbSetup, recordRequests, WORKSPACE_SLUG } from "./support/kb";
import { fakeStream } from "./support/live";
import { renderApp } from "./support/render";

function renderPath(db: ReturnType<typeof kbSetup>["db"], path: string) {
  const stream = fakeStream(db);
  return renderApp(path, db, [], { createEventSource: stream.factory });
}

const entryPath = (id: string) => `/w/${WORKSPACE_SLUG}/kb/${id}`;
const bodyField = () => screen.getByLabelText("Text") as HTMLTextAreaElement;

describe("note and brainstorm editor", () => {
  it("saves changed fields with ⌘S and expectedUpdatedAt", async () => {
    const { db, note } = kbSetup();
    const loadedAt = note.updatedAt;
    const requests = recordRequests();
    const { user } = renderPath(db, entryPath(note.id));

    expect(await screen.findByText("All changes saved")).toBeInTheDocument();
    await user.click(bodyField());
    await user.type(bodyField(), "\n- Hide the minimap");
    expect(screen.getByText("Unsaved changes, kept on this device")).toBeInTheDocument();

    await user.keyboard("{Meta>}s{/Meta}");

    expect(await screen.findByText("All changes saved")).toBeInTheDocument();
    const patch = requests.find((request) => request.method === "PATCH");
    expect(patch?.body).toEqual({
      expectedUpdatedAt: loadedAt,
      bodyMd: "- Editor font at 22 pt\n- Hide the minimap",
    });
    expect(db.kbEntries.find((entry) => entry.id === note.id)?.bodyMd).toContain("minimap");
  });

  it("shows the conflict banner on 409 and overwrites on request", async () => {
    const { db, note } = kbSetup();
    const loadedAt = note.updatedAt;
    const requests = recordRequests();
    const { user } = renderPath(db, entryPath(note.id));
    await screen.findByText("All changes saved");

    // Someone else saves the note; this client hears nothing about it.
    const stored = db.kbEntries.find((entry) => entry.id === note.id);
    if (!stored) throw new Error("missing note");
    stored.bodyMd = "Changed elsewhere";
    const elsewhereAt = new Date().toISOString();
    stored.updatedAt = elsewhereAt;

    await user.type(bodyField(), " plus mine");
    await user.click(screen.getByRole("button", { name: /^save/i }));

    const banner = await screen.findByRole("alert");
    expect(banner).toHaveTextContent("This entry changed elsewhere since you opened it.");

    await user.click(within(banner).getByRole("button", { name: "Overwrite" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(stored.bodyMd).toBe("- Editor font at 22 pt plus mine");

    const patches = requests.filter((request) => request.method === "PATCH");
    expect(patches).toHaveLength(2);
    expect(patches[0]?.body).toMatchObject({ expectedUpdatedAt: loadedAt });
    expect(patches[1]?.body).toMatchObject({ expectedUpdatedAt: elsewhereAt });
  });

  it("reloads the stored version from the conflict banner", async () => {
    const { db, note } = kbSetup();
    const { user } = renderPath(db, entryPath(note.id));
    await screen.findByText("All changes saved");

    const stored = db.kbEntries.find((entry) => entry.id === note.id);
    if (!stored) throw new Error("missing note");
    stored.title = "Renamed elsewhere";
    stored.updatedAt = new Date().toISOString();

    await user.type(screen.getByLabelText("Title"), "!");
    await user.keyboard("{Control>}s{/Control}");
    const banner = await screen.findByRole("alert");
    await user.click(within(banner).getByRole("button", { name: "Reload" }));

    await waitFor(() => expect(screen.getByLabelText("Title")).toHaveValue("Renamed elsewhere"));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("All changes saved")).toBeInTheDocument();
  });

  it("warns when a live update changes the entry being edited", async () => {
    const { db, note } = kbSetup();
    const { user } = renderPath(db, entryPath(note.id));
    await screen.findByText("All changes saved");
    await user.type(bodyField(), " mine");

    act(() => {
      updateKbEntry(db, note.id, (entry) => {
        entry.bodyMd = "From an MCP client";
      });
    });

    expect(await screen.findByText(/changed elsewhere while you were editing/)).toBeInTheDocument();
    // The user's text stays until they choose.
    expect(bodyField().value).toContain("mine");
  });

  it("keeps a draft in localStorage and restores it", async () => {
    const { db, note } = kbSetup();
    const { user, router } = renderPath(db, entryPath(note.id));
    await screen.findByText("All changes saved");

    await user.type(bodyField(), " draft text");
    const key = draftKey({ entryId: note.id });
    await waitFor(() => expect(window.localStorage.getItem(key)).toContain("draft text"));

    await act(() =>
      router.navigate({
        to: "/w/$workspace/kb",
        params: { workspace: WORKSPACE_SLUG },
      }),
    );
    await screen.findByRole("list", { name: "All entries" });
    await act(() =>
      router.navigate({
        to: "/w/$workspace/kb/$entryId",
        params: { workspace: WORKSPACE_SLUG, entryId: note.id },
      }),
    );

    expect(await screen.findByText(/Restored your unsaved changes/)).toBeInTheDocument();
    expect(bodyField().value).toBe("- Editor font at 22 pt draft text");

    await user.click(screen.getByRole("button", { name: "Discard them" }));
    expect(bodyField().value).toBe("- Editor font at 22 pt");
    await waitFor(() => expect(window.localStorage.getItem(key)).toBeNull());
  });

  it("creates a brainstorm with tags and previews markdown without raw HTML", async () => {
    const { db } = kbSetup();
    const requests = recordRequests();
    const { user, router } = renderPath(db, `/w/${WORKSPACE_SLUG}/kb/new?kind=brainstorm`);

    const title = await screen.findByLabelText("Title");
    expect(title).toHaveFocus();
    await user.type(title, "Ownership arc");

    const tags = screen.getByLabelText("Tags");
    await user.type(tags, "Rust Errors{Enter}series,hooks,");
    const chips = screen.getByRole("list", { name: "Tags" });
    expect(
      within(chips)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["#rust-errors", "#series", "#hooks"]);
    await user.type(tags, "{Backspace}");
    expect(within(chips).getAllByRole("listitem")).toHaveLength(2);
    await user.type(tags, "-bad{Enter}");
    expect(screen.getByText(/Tags use lowercase letters/)).toBeInTheDocument();
    await user.clear(tags);

    await user.type(bodyField(), "<b>raw</b> and **bold**");
    await user.click(screen.getByRole("tab", { name: "Preview" }));
    const preview = screen.getByText("bold").closest<HTMLElement>('[role="tabpanel"]');
    if (!preview) throw new Error("no preview panel");
    expect(within(preview).getByText("bold").tagName).toBe("STRONG");
    expect(preview.querySelector("b")).toBeNull();
    expect(preview).toHaveTextContent("<b>raw</b> and bold");

    await user.click(screen.getByRole("button", { name: /save brainstorm/i }));
    await waitFor(() => expect(router.state.location.pathname).toMatch(/\/kb\/[0-9a-f-]{36}$/));
    expect(requests.find((request) => request.method === "POST")?.body).toEqual({
      kind: "brainstorm",
      title: "Ownership arc",
      bodyMd: "<b>raw</b> and **bold**",
      tags: ["rust-errors", "series"],
    });
    expect(await screen.findByText("All changes saved")).toBeInTheDocument();
  });

  it("asks for a title before saving", async () => {
    const { db } = kbSetup();
    const { user } = renderPath(db, `/w/${WORKSPACE_SLUG}/kb/new?kind=note`);
    await user.click(await screen.findByRole("button", { name: /save note/i }));
    expect(screen.getByText("Give the entry a title.")).toBeInTheDocument();
    expect(screen.getByLabelText("Title")).toHaveFocus();
  });
});

describe("decision log", () => {
  it("lists decisions as a timeline and supersedes one", async () => {
    const { db, decision } = kbSetup();
    const { user, router } = renderPath(db, `/w/${WORKSPACE_SLUG}/kb?kind=decision`);

    const log = await screen.findByRole("list", { name: "Decision log" });
    expect(within(log).getByText("Captions in the lower third")).toBeInTheDocument();
    expect(within(log).getByText("Active")).toBeInTheDocument();

    await user.click(
      within(log).getByRole("link", { name: "Supersede “Captions in the lower third”" }),
    );
    expect(await screen.findByRole("heading", { name: "Replace a decision" })).toBeInTheDocument();
    // Tags carry over from the decision being replaced.
    expect(screen.getByRole("list", { name: "Tags" })).toHaveTextContent("#captions");

    await user.type(screen.getByLabelText("Title"), "Captions at the top");
    await user.type(screen.getByLabelText("Decision"), "Captions sit at the top.");
    await user.type(screen.getByLabelText(/^why/i), "Lower third clashes with the progress bar.");
    await user.click(screen.getByRole("button", { name: /record decision/i }));

    await waitFor(() => expect(router.state.location.pathname).not.toMatch(/\/new$/));
    const old = db.kbEntries.find((entry) => entry.id === decision.id);
    const replacement = db.kbEntries.find((entry) => entry.title === "Captions at the top");
    const oldData = old?.data as DecisionData | undefined;
    expect(oldData?.status).toBe("superseded");
    expect(oldData?.supersededBy).toBe(replacement?.id);
    expect(await screen.findByRole("heading", { name: "Captions at the top" })).toBeInTheDocument();

    await act(() =>
      router.navigate({
        to: "/w/$workspace/kb",
        params: { workspace: WORKSPACE_SLUG },
        search: { kind: "decision" },
      }),
    );
    const updated = await screen.findByRole("list", { name: "Decision log" });
    await waitFor(() => expect(within(updated).getByText("Superseded")).toBeInTheDocument());
    expect(
      within(updated).getByRole("link", { name: "Superseded by Captions at the top" }),
    ).toBeInTheDocument();
  });

  it("requires the decision text", async () => {
    const { db } = kbSetup();
    const { user } = renderPath(db, `/w/${WORKSPACE_SLUG}/kb/new?kind=decision`);
    await user.type(await screen.findByLabelText("Title"), "Something");
    await user.keyboard("{Meta>}s{/Meta}");
    expect(screen.getByText("Say what was decided.")).toBeInTheDocument();
    expect(screen.getByLabelText("Decision")).toHaveFocus();
  });
});
