import type { ApprovalItem, ApprovalsInbox, ContentItem } from "@loomcast/contracts";
import { routes } from "@loomcast/contracts";
import { screen, waitFor, within } from "@testing-library/react";
import { getResponse, HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatSpan, slotCountdown } from "@/features/approvals/countdown";
import { compareApprovals, compareMissed } from "@/features/approvals/queries";
import { suggestedTime } from "@/features/approvals/RescheduleDialog";
import { mockPost } from "@/mocks/calendar";
import { mockContentItem } from "@/mocks/content";
import { MOCK_USER } from "@/mocks/db";
import { createHandlers } from "@/mocks/handlers";
import { CALENDAR_NOW, calendarSetup } from "./support/calendar";
import { recordRequests } from "./support/kb";
import { fakeStream } from "./support/live";
import { renderApp } from "./support/render";

const HOUR = 60 * 60_000;
const NOW = Date.parse(CALENDAR_NOW);
const inHours = (hours: number) => new Date(NOW + hours * HOUR).toISOString();

beforeEach(() => {
  // Only the clock is fixed; timers stay real for the router, MSW and user-event.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(CALENDAR_NOW));
});
afterEach(() => {
  vi.useRealTimers();
});

/**
 * The calendar setup plus four videos in review and one missed post:
 * - `soon`: a planned Threads post in 1 h 30 m (red);
 * - `tomorrow`: a queued Instagram post in 22 h (amber);
 * - `later`: Instagram and Threads posts, the first in 57 h (blue);
 * - `undated`: no post yet, waiting longest of all (last anyway);
 * - `missed`: the approved `result` item's Threads post, due 15 hours ago.
 */
function approvalsSetup() {
  const setup = calendarSetup();
  const { db, workspace, series, channels } = setup;
  const add = (title: string, updatedAt: string): ContentItem => {
    const { item, versions } = mockContentItem({
      workspaceId: workspace.id,
      seriesId: series.ownership.id,
      title,
      state: "review",
      versionNo: 4,
      createdBy: MOCK_USER.id,
      createdAt: "2026-10-01T08:00:00.000Z",
      updatedAt,
    });
    db.contentItems.push(item);
    db.contentVersions.push(...versions);
    return item;
  };
  const undated = add("Lifetimes without tears", "2026-10-02T08:00:00.000Z");
  const later = add("Borrowing in one picture", "2026-10-05T08:00:00.000Z");
  const tomorrow = add("Clone is not free", "2026-10-06T08:00:00.000Z");
  const soon = add("Slices point at memory", "2026-10-07T08:00:00.000Z");
  db.posts.push(
    mockPost({
      item: soon,
      channel: channels.threads,
      scheduledAt: inHours(1.5),
      status: "planned",
    }),
    mockPost({ item: tomorrow, channel: channels.instagram, scheduledAt: inHours(22) }),
    mockPost({ item: later, channel: channels.threads, scheduledAt: inHours(60) }),
    mockPost({ item: later, channel: channels.instagram, scheduledAt: inHours(57) }),
  );
  const missed = mockPost({
    item: setup.items.result,
    channel: channels.threads,
    scheduledAt: inHours(-15),
    status: "missed",
    createdAt: "2026-10-01T08:00:00.000Z",
  });
  db.posts.push(missed);
  return { ...setup, review: { soon, tomorrow, later, undated }, missed };
}

function waitingTitles() {
  const list = screen.getByRole("list", { name: "Videos waiting for approval" });
  return within(list)
    .getAllByRole("listitem")
    .map((row) => row.getAttribute("aria-label"));
}

function waitingRow(title: string) {
  const list = screen.getByRole("list", { name: "Videos waiting for approval" });
  return within(list).getByRole("listitem", { name: title });
}

/** The toast with this title about this video; toasts of earlier tests may still be showing. */
function findToast(title: string, description: string) {
  return waitFor(() => {
    const toast = [...document.querySelectorAll<HTMLElement>("[data-sonner-toast]")].find(
      (node) =>
        within(node).queryByText(title) !== null && within(node).queryByText(description) !== null,
    );
    if (!toast) throw new Error(`expected a "${title}" toast for ${description}`);
    return toast;
  });
}

function countdownOf(row: HTMLElement) {
  const pill = row.querySelector<HTMLElement>("[data-countdown]");
  if (!pill) throw new Error("expected a countdown");
  return { tone: pill.dataset.tone, text: pill.textContent };
}

describe("approvals inbox", () => {
  it("lists videos nearest slot first, each with a countdown, and videos without a slot last", async () => {
    const { db, review } = approvalsSetup();
    renderApp("/approvals", db);
    await screen.findByRole("list", { name: "Videos waiting for approval" }, { timeout: 5000 });

    expect(waitingTitles()).toEqual([
      review.soon.title,
      review.tomorrow.title,
      review.later.title,
      review.undated.title,
    ]);
    expect(countdownOf(waitingRow(review.soon.title))).toEqual({
      tone: "red",
      text: "1h 30m1h 30m until its slot",
    });
    expect(countdownOf(waitingRow(review.tomorrow.title)).tone).toBe("amber");
    expect(countdownOf(waitingRow(review.later.title))).toMatchObject({ tone: "blue" });
    expect(countdownOf(waitingRow(review.later.title)).text).toMatch(/^2d 9h/);
    expect(countdownOf(waitingRow(review.undated.title)).text).toMatch(/^No slot/);
    expect(
      within(waitingRow(review.later.title)).getByText(
        "Posts on @rustin60 (Instagram), Rust threads (Threads)",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/4 videos waiting/)).toHaveTextContent(
      "4 videos waiting · 2 due within a day · 1 missed post",
    );
  });

  it("sorts what the server sends, whatever its order", async () => {
    const { db, review } = approvalsSetup();
    // The server answers newest first; the inbox still puts the nearest slot on top.
    const shuffled = http.get(`*${routes["approvals.inbox"].path}`, () => {
      const entry = (item: ContentItem, deadlineAt: string | null): ApprovalItem => ({
        item,
        deadlineAt,
        posts: [],
      });
      const body: ApprovalsInbox = {
        items: [
          entry(review.undated, null),
          entry(review.later, inHours(57)),
          entry(review.soon, inHours(1.5)),
          entry(review.tomorrow, inHours(22)),
        ],
        missed: [],
      };
      return HttpResponse.json(body);
    });
    renderApp("/approvals", db, [shuffled]);
    await screen.findByRole("list", { name: "Videos waiting for approval" }, { timeout: 5000 });
    expect(waitingTitles()).toEqual([
      review.soon.title,
      review.tomorrow.title,
      review.later.title,
      review.undated.title,
    ]);
  });

  it("approves a video from its row on the version it shows", async () => {
    const { db, review } = approvalsSetup();
    const requests = recordRequests();
    const { user } = renderApp("/approvals", db);
    await screen.findByRole("list", { name: "Videos waiting for approval" }, { timeout: 5000 });

    await user.click(screen.getByRole("button", { name: `Approve ${review.tomorrow.title}` }));

    await waitFor(() => expect(waitingTitles()).not.toContain(review.tomorrow.title));
    expect(requests.find((request) => request.method === "POST")).toMatchObject({
      path: `/api/content/${review.tomorrow.id}/reviews`,
      body: { versionId: review.tomorrow.currentVersionId, decision: "approve" },
    });
    expect(db.contentItems.find((item) => item.id === review.tomorrow.id)?.state).toBe("approved");
    expect(await screen.findByText("Approved")).toBeInTheDocument();
  });

  it("confirms each decision even when the live stream removes the row first", async () => {
    // The API publishes the item's new state before it answers, so with the stream open the row
    // leaves the inbox (and unmounts) before the decision's response arrives.
    const { db, review } = approvalsSetup();
    const stream = fakeStream(db);
    const late = http.post(`*${routes["reviews.create"].path}`, async ({ request, params }) => {
      const response = await getResponse(createHandlers(db), request);
      const title = db.contentItems.find((item) => item.id === params.id)?.title;
      await waitFor(() => expect(waitingTitles()).not.toContain(title));
      return response;
    });
    const { user } = renderApp("/approvals", db, [late], { createEventSource: stream.factory });
    await screen.findByRole("list", { name: "Videos waiting for approval" }, { timeout: 5000 });

    await user.click(screen.getByRole("button", { name: `Approve ${review.later.title}` }));
    expect(await findToast("Approved", review.later.title)).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: `Request changes to ${review.undated.title}` }),
    );
    const form = screen.getByRole("form", { name: `Request changes to ${review.undated.title}` });
    await user.type(within(form).getByLabelText("What should change?"), "The hook runs long.");
    await user.click(within(form).getByRole("button", { name: "Send" }));
    expect(await findToast("Changes requested", review.undated.title)).toBeInTheDocument();
  });

  it("asks for changes inline, and needs a comment first", async () => {
    const { db, review } = approvalsSetup();
    const requests = recordRequests();
    const { user } = renderApp("/approvals", db);
    await screen.findByRole("list", { name: "Videos waiting for approval" }, { timeout: 5000 });

    await user.click(
      screen.getByRole("button", { name: `Request changes to ${review.soon.title}` }),
    );
    const form = screen.getByRole("form", { name: `Request changes to ${review.soon.title}` });
    await user.click(within(form).getByRole("button", { name: "Send" }));
    expect(within(form).getByRole("alert")).toHaveTextContent("Say what should change.");
    expect(requests.some((request) => request.method === "POST")).toBe(false);

    await user.type(within(form).getByLabelText("What should change?"), "The hook runs long.");
    await user.click(within(form).getByRole("checkbox", { name: "Ask the producer to revise" }));
    await user.click(within(form).getByRole("button", { name: "Send" }));

    await waitFor(() => expect(waitingTitles()).not.toContain(review.soon.title));
    expect(requests.find((request) => request.method === "POST")?.body).toEqual({
      versionId: review.soon.currentVersionId,
      decision: "request_changes",
      comment: "The hook runs long.",
      enqueueRevision: false,
    });
    expect(db.contentItems.find((item) => item.id === review.soon.id)?.state).not.toBe("review");
  });

  it("says why a decision failed and reloads the inbox", async () => {
    const { db, review } = approvalsSetup();
    const { user } = renderApp("/approvals", db);
    await screen.findByRole("list", { name: "Videos waiting for approval" }, { timeout: 5000 });
    // A newer version arrived since the inbox loaded.
    const item = db.contentItems.find((entry) => entry.id === review.later.id);
    if (item) item.currentVersionId = "00000000-0000-4000-8000-00000000beef";

    await user.click(screen.getByRole("button", { name: `Approve ${review.later.title}` }));
    expect(await screen.findByText("Couldn't approve")).toBeInTheDocument();
    expect(
      screen.getByText(
        "The video changed since the inbox loaded. It now shows the latest version.",
      ),
    ).toBeInTheDocument();
    expect(waitingTitles()).toContain(review.later.title);
  });

  it("reschedules a missed post, which then waits for its new time", async () => {
    const { db, missed, items } = approvalsSetup();
    const loadedAt = missed.updatedAt;
    const requests = recordRequests();
    const { user } = renderApp("/approvals", db);
    const list = await screen.findByRole("list", { name: "Missed posts" }, { timeout: 5000 });
    const row = within(list).getByRole("listitem", {
      name: `${items.result.title} on Rust threads (Threads)`,
    });
    expect(within(row).getByText("Missed")).toHaveAttribute("data-tone", "red");

    await user.click(
      within(row).getByRole("button", {
        name: `Reschedule ${items.result.title} on Rust threads (Threads)`,
      }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Reschedule post" });
    await user.click(within(dialog).getByRole("button", { name: "Reschedule" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(requests.find((request) => request.method === "PATCH")).toMatchObject({
      path: `/api/scheduled-posts/${missed.id}`,
      body: {
        scheduledAt: new Date(suggestedTime(NOW)).toISOString(),
        expectedUpdatedAt: loadedAt,
      },
    });
    expect(db.posts.find((post) => post.id === missed.id)?.status).toBe("queued");
    expect(await screen.findByText("No missed posts")).toBeInTheDocument();
  });

  it("narrows the inbox to one workspace from the address", async () => {
    const { db } = approvalsSetup();
    const requests = recordRequests();
    renderApp(`/approvals?workspace=${db.workspaces[0]?.id}`, db);
    await screen.findByRole("list", { name: "Videos waiting for approval" }, { timeout: 5000 });
    expect(
      requests.find((request) => request.path === "/api/approvals")?.query.get("workspaceId"),
    ).toBe(db.workspaces[0]?.id);
  });
});

describe("approval order and countdowns", () => {
  const entry = (id: string, deadlineAt: string | null, updatedAt: string): ApprovalItem => ({
    item: mockContentItem({ id, workspaceId: "p", title: id, state: "review", updatedAt }).item,
    deadlineAt,
    posts: [],
  });

  it("puts the nearest deadline first, then the longest waiting, then by id, undated last", () => {
    const sorted = [
      entry("c", null, "2026-10-01T00:00:00.000Z"),
      entry("b", inHours(5), "2026-10-03T00:00:00.000Z"),
      entry("e", inHours(5), "2026-10-02T00:00:00.000Z"),
      entry("a", inHours(2), "2026-10-09T00:00:00.000Z"),
      entry("d", null, "2026-10-01T00:00:00.000Z"),
    ].sort(compareApprovals);
    expect(sorted.map((item) => item.item.id)).toEqual(["a", "e", "b", "c", "d"]);
  });

  it("lists missed posts most recent first", () => {
    const { items, channels } = calendarSetup();
    const post = (id: string, hours: number) =>
      mockPost({
        id,
        item: items.result,
        channel: channels.threads,
        scheduledAt: inHours(hours),
        status: "missed",
      });
    expect(
      [post("a", -30), post("b", -2), post("c", -12)].sort(compareMissed).map((p) => p.id),
    ).toEqual(["b", "c", "a"]);
  });

  it("colours the time left: red under two hours, amber within a day, blue within three", () => {
    expect(slotCountdown(inHours(1.99), NOW).tone).toBe("red");
    expect(slotCountdown(inHours(2), NOW).tone).toBe("amber");
    expect(slotCountdown(inHours(23.9), NOW).tone).toBe("amber");
    expect(slotCountdown(inHours(24), NOW).tone).toBe("blue");
    expect(slotCountdown(inHours(71), NOW).tone).toBe("blue");
    expect(slotCountdown(inHours(72), NOW).tone).toBe("gray");
    expect(slotCountdown(null, NOW)).toMatchObject({ label: "No slot", tone: "gray" });
    expect(slotCountdown(inHours(-0.5), NOW)).toEqual({
      label: "30m late",
      tone: "red",
      description: "Its slot passed 30m ago",
    });
  });

  it("shows at most two units and never rounds up past the slot", () => {
    expect(formatSpan(10_000)).toBe("1m");
    expect(formatSpan(59.9 * 60_000)).toBe("59m");
    expect(formatSpan(3 * HOUR)).toBe("3h");
    expect(formatSpan(3 * HOUR + 12 * 60_000 + 59_000)).toBe("3h 12m");
    expect(formatSpan(52 * HOUR + 59 * 60_000)).toBe("2d 4h");
    expect(formatSpan(48 * HOUR)).toBe("2d");
  });

  it("suggests the first full hour at least an hour away", () => {
    const suggested = suggestedTime(Date.parse("2026-10-14T08:20:00.000Z"));
    expect(new Date(suggested).getMinutes()).toBe(0);
    expect(suggested - Date.parse("2026-10-14T08:20:00.000Z")).toBeGreaterThanOrEqual(HOUR);
    expect(suggested - Date.parse("2026-10-14T08:20:00.000Z")).toBeLessThanOrEqual(2 * HOUR);
  });
});
