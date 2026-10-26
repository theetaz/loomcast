import type { Device, Workspace } from "@loomcast/contracts";
import { act, screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import {
  mockConversation,
  mockJob,
  mockMessage,
  storeMessage,
  updateJob,
} from "@/mocks/conversations";
import { createMockDb, MOCK_USER, type MockDb, mockId, mockWorkspace, publish } from "@/mocks/db";
import { fakeStream } from "./support/live";
import { renderApp } from "./support/render";
import { server } from "./support/server";

function studio(online: boolean): Device {
  return {
    id: mockId(),
    name: "Studio Mac mini",
    platform: "darwin-arm64",
    agentVersion: "0.1.0",
    online,
    lastSeenAt: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    revokedAt: null,
  };
}

function setup({ online = true, conversations = true } = {}) {
  const workspace: Workspace = mockWorkspace({
    name: "Rust in 60 seconds",
    slug: "rust-in-60-seconds",
  });
  const db = createMockDb({ signedIn: true, workspaces: [workspace], devices: [studio(online)] });
  const conversation = mockConversation({
    workspaceId: workspace.id,
    createdBy: MOCK_USER.id,
    title: "Ownership in one minute",
    createdAt: "2026-10-13T09:00:00.000Z",
    lastMessageAt: "2026-10-13T09:01:00.000Z",
  });
  if (conversations) {
    const older = mockConversation({
      workspaceId: workspace.id,
      createdBy: MOCK_USER.id,
      title: "Series ideas",
      createdAt: "2026-10-10T09:00:00.000Z",
      lastMessageAt: "2026-10-10T09:01:00.000Z",
    });
    db.conversations.push(older, conversation);
    db.messages.push(
      mockMessage({
        conversationId: conversation.id,
        role: "user",
        content: { text: "Draft a short on ownership" },
        createdAt: "2026-10-13T09:00:00.000Z",
      }),
      mockMessage({
        conversationId: conversation.id,
        role: "assistant",
        content: { text: "Every value has **one owner**." },
        createdAt: "2026-10-13T09:01:00.000Z",
      }),
      mockMessage({
        conversationId: older.id,
        role: "assistant",
        content: { text: "Five ideas for the series" },
        createdAt: "2026-10-10T09:01:00.000Z",
      }),
    );
  }
  return { db, workspace, conversation };
}

/** Records the bodies of `POST` requests to `pathname`, as sent. */
function recordPosts(pattern: RegExp) {
  const bodies: unknown[] = [];
  server.events.on("request:start", async ({ request }) => {
    if (request.method === "POST" && pattern.test(new URL(request.url).pathname)) {
      bodies.push(
        await request
          .clone()
          .json()
          .catch(() => null),
      );
    }
  });
  return bodies;
}

function renderPanel(db: MockDb, path: string, overrides: Parameters<typeof renderApp>[2] = []) {
  const stream = fakeStream(db);
  const view = renderApp(path, db, overrides, { createEventSource: stream.factory });
  return { ...view, stream };
}

const messages = () => screen.getByRole("region", { name: "Messages" });
/** Waits for the thread to show `text`. */
async function ready(text = "Draft a short on ownership") {
  const region = await screen.findByRole("region", { name: "Messages" });
  return within(region).findByText(text);
}
const composer = () => screen.getByRole("textbox", { name: "Message the studio agent" });

describe("conversation panel", () => {
  it("lists conversations, opens the latest and renders its messages", async () => {
    const { db, workspace } = setup();
    const { user, router } = renderPanel(db, `/w/${workspace.slug}/chat`);

    const nav = await screen.findByRole("navigation", { name: "Conversations" });
    const links = await within(nav).findAllByRole("link");
    expect(links.map((link) => link.textContent)).toEqual([
      expect.stringContaining("Ownership in one minute"),
      expect.stringContaining("Series ideas"),
    ]);
    expect(links[0]).toHaveAttribute("aria-current", "page");

    expect(await ready()).toBeInTheDocument();
    expect(within(messages()).getByText("one owner").tagName).toBe("STRONG");

    await user.click(links[1] as HTMLElement);
    expect(await within(messages()).findByText("Five ideas for the series")).toBeInTheDocument();
    expect(router.state.location.search).toEqual({
      conversation: db.conversations[0]?.id,
    });
  });

  it("shows an empty state, and the first message starts a conversation", async () => {
    const { db, workspace } = setup({ conversations: false });
    const { user } = renderPanel(db, `/w/${workspace.id}/chat`);

    expect(await screen.findByText("Start a conversation")).toBeInTheDocument();
    await user.type(composer(), "Plan the first short");
    await user.keyboard("{Meta>}{Enter}{/Meta}");

    expect(await within(messages()).findByText("Plan the first short")).toBeInTheDocument();
    await waitFor(() => expect(db.conversations).toHaveLength(1));
    expect(db.messages[0]?.content.text).toBe("Plan the first short");
    expect(composer()).toHaveFocus();
  });

  it("shows the error and retries", async () => {
    const { db, workspace } = setup();
    let fail = true;
    const { user } = renderPanel(db, `/w/${workspace.id}/chat`, [
      http.get("*/api/workspaces/:workspaceId/conversations", () =>
        fail
          ? HttpResponse.json({ error: { code: "internal", message: "Boom" } }, { status: 500 })
          : undefined,
      ),
    ]);

    expect(await screen.findByText("Couldn't load the conversations")).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole("button", { name: /try again/i }));
    expect(await ready()).toBeInTheDocument();
  });

  it("sends from the keyboard with an optimistic message the stored one replaces", async () => {
    const { db, workspace, conversation } = setup({ online: false });
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const posted = recordPosts(/\/messages$/);
    const { user } = renderPanel(db, `/w/${workspace.id}/chat`, [
      http.post("*/api/conversations/:id/messages", async () => {
        await held;
        return undefined;
      }),
    ]);
    await ready();

    await user.type(composer(), "Write a hook{Shift>}{Enter}{/Shift}about lifetimes");
    await user.keyboard("{Control>}{Enter}{/Control}");

    // Shown straight away, cleared from the composer, and not animated in.
    const bubble = within(messages()).getByText(/Write a hook\s+about lifetimes/);
    expect(composer()).toHaveValue("");
    expect(bubble.closest("[aria-busy]")).toBeInTheDocument();
    expect(bubble.parentElement?.className).not.toMatch(/animate-in/);
    // Sending is off until the API answers; typing is not.
    await user.type(composer(), "Next");
    expect(screen.getByRole("button", { name: "Sending" })).toBeDisabled();

    release();
    await waitFor(() =>
      expect(db.messages.some((m) => m.content.text.includes("hook"))).toBe(true),
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled());

    // The stored message took over the same element: one bubble, no longer busy.
    const stored = within(messages()).getByText(/Write a hook\s+about lifetimes/);
    expect(stored).toBe(bubble);
    expect(within(messages()).getAllByText(/Write a hook/)).toHaveLength(1);
    expect(stored.closest("[aria-busy]")).toBeNull();
    expect(posted).toEqual([
      { text: "Write a hook\nabout lifetimes", clientMessageId: expect.any(String) },
    ]);
    expect(db.messages.at(-1)?.clientMessageId).toBe(
      (posted[0] as { clientMessageId: string }).clientMessageId,
    );
    expect(db.messages.at(-1)?.conversationId).toBe(conversation.id);

    // Nobody is there to run it.
    expect(await screen.findByText("Waiting for studio agent (offline)")).toBeInTheDocument();
  });

  it("animates a message sent with the pointer", async () => {
    const { db, workspace } = setup();
    const { user } = renderPanel(db, `/w/${workspace.id}/chat`);
    await ready();

    await user.type(composer(), "Clicked");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    const bubble = await within(messages()).findByText("Clicked");
    expect(bubble.parentElement?.className).toMatch(/animate-in/);
  });

  it("streams the reply and follows the job to the end", async () => {
    const { db, workspace, conversation } = setup();
    renderPanel(db, `/w/${workspace.id}/chat`);
    await ready();

    const job = mockJob({ workspaceId: workspace.id, conversationId: conversation.id });
    db.jobs.push(job);
    act(() => {
      storeMessage(
        db,
        mockMessage({
          conversationId: conversation.id,
          role: "user",
          jobId: job.id,
          content: { text: "From another tab" },
        }),
      );
      publish(db, { type: "job.updated", payload: { job } });
    });
    expect(await within(messages()).findByText("From another tab")).toBeInTheDocument();
    expect(await screen.findByText("Queued")).toBeInTheDocument();

    act(() => {
      updateJob(db, job.id, { status: "running" });
      publish(db, {
        type: "job.activity",
        payload: { jobId: job.id, kind: "Read", summary: "Reading PROJECT.md" },
      });
    });
    expect(await screen.findByText("Running")).toBeInTheDocument();
    expect(screen.getByText("Reading PROJECT.md")).toBeInTheDocument();

    act(() => {
      for (const text of ["Here's ", "a **hook**", " for you."]) {
        publish(db, {
          type: "conversation.message.delta",
          payload: { conversationId: conversation.id, jobId: job.id, text },
        });
      }
    });
    const draft = await within(messages()).findByText(/for you\./);
    expect(draft.closest("[aria-busy]")).toBeInTheDocument();
    expect(within(draft).getByText("hook").tagName).toBe("STRONG");

    act(() => {
      storeMessage(
        db,
        mockMessage({
          conversationId: conversation.id,
          role: "assistant",
          jobId: job.id,
          content: { text: "Here's a **hook** for you." },
        }),
      );
      updateJob(db, job.id, { status: "succeeded" });
    });
    await waitFor(() => expect(within(messages()).getAllByText(/for you\./)).toHaveLength(1));
    expect(
      within(messages())
        .getByText(/for you\./)
        .closest("[aria-busy]"),
    ).toBeNull();
    await waitFor(() => expect(screen.queryByText("Running")).not.toBeInTheDocument());
    expect(screen.getByText("The studio agent replied.")).toBeInTheDocument();
  });

  it("cancels a queued reply", async () => {
    const { db, workspace } = setup();
    const posted = recordPosts(/\/cancel$/);
    const { user } = renderPanel(db, `/w/${workspace.id}/chat`);
    await ready();

    await user.type(composer(), "Never mind");
    await user.keyboard("{Meta>}{Enter}{/Meta}");
    expect(await screen.findByText("Queued")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await screen.findByText("Cancelled")).toBeInTheDocument();
    expect(posted).toHaveLength(1);
    expect(db.jobs[0]?.status).toBe("cancelled");
  });

  it("retries a failed reply with the same text and a new client message id", async () => {
    const { db, workspace } = setup();
    const posted = recordPosts(/\/messages$/);
    const { user } = renderPanel(db, `/w/${workspace.id}/chat`);
    await ready();

    await user.type(composer(), "Draft the captions");
    await user.keyboard("{Meta>}{Enter}{/Meta}");
    await screen.findByText("Queued");
    const job = db.jobs[0];
    if (!job) throw new Error("no job");

    act(() => {
      updateJob(db, job.id, {
        status: "failed",
        error: {
          code: "producer_not_authenticated",
          message: "Log in to the producer runtime on this Mac.",
          retryable: false,
        },
      });
    });
    expect(await screen.findByText("Failed")).toBeInTheDocument();
    expect(screen.getByText("Log in to the producer runtime on this Mac.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(posted).toHaveLength(2));
    const [first, second] = posted as { text: string; clientMessageId: string }[];
    expect(second?.text).toBe("Draft the captions");
    expect(second?.clientMessageId).not.toBe(first?.clientMessageId);
    expect(await screen.findByText("Queued")).toBeInTheDocument();
  });

  it("keeps an unsent message with a retry that reuses its id", async () => {
    const { db, workspace } = setup();
    let fail = true;
    const posted = recordPosts(/\/messages$/);
    const { user } = renderPanel(db, `/w/${workspace.id}/chat`, [
      http.post("*/api/conversations/:id/messages", () =>
        fail ? HttpResponse.error() : undefined,
      ),
    ]);
    await ready();

    await user.type(composer(), "Lost in transit");
    await user.keyboard("{Meta>}{Enter}{/Meta}");
    const alert = await within(messages()).findByRole("alert");
    expect(alert).toHaveTextContent("Not sent");

    fail = false;
    await user.click(within(alert).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(within(messages()).queryByRole("alert")).not.toBeInTheDocument());
    expect(db.messages.filter((m) => m.content.text === "Lost in transit")).toHaveLength(1);
    const [first, second] = posted as { clientMessageId: string }[];
    expect(second?.clientMessageId).toBe(first?.clientMessageId);
  });

  it("reads the messages again after the live stream reconnects", async () => {
    const { db, workspace, conversation } = setup();
    const { stream } = renderPanel(db, `/w/${workspace.id}/chat`);
    await ready();

    // Stored while the stream was down: no event arrives for it.
    act(() => stream.latest().fail(true));
    db.messages.push(
      mockMessage({
        conversationId: conversation.id,
        role: "assistant",
        content: { text: "Sent while you were away" },
      }),
    );
    act(() => stream.latest().open());

    expect(await within(messages()).findByText("Sent while you were away")).toBeInTheDocument();
  });
});

describe("conversation panel address", () => {
  it.each([
    ["a malformed id", "not-an-id"],
    ["an unknown id", "3f2a7c1e-9b4d-4e8f-a1c2-5d6e7f8a9b0c"],
  ])("opens the latest conversation for %s", async (_label, id) => {
    const { db, workspace } = setup();
    renderPanel(db, `/w/${workspace.id}?conversation=${id}`);

    expect(await ready()).toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: "Conversations" });
    expect(within(nav).getAllByRole("link")[0]).toHaveAttribute("aria-current", "page");
  });
});
