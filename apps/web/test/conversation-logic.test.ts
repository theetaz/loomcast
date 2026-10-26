import type { JobSummary, Message } from "@loomcast/contracts";
import { describe, expect, it, vi } from "vitest";
import { describeJob, laterJob } from "@/features/conversation/job-status";
import {
  buildTimeline,
  type PendingMessage,
  sortMessages,
  upsertMessage,
} from "@/features/conversation/messages";
import { distanceFromBottom, nextPinned } from "@/features/conversation/scroll";
import { appendDelta, createConversationStore, settleDraft } from "@/features/conversation/store";
import { mockJob, mockMessage } from "@/mocks/conversations";
import { mockId } from "@/mocks/db";

const conversationId = mockId();
const workspaceId = mockId();

function assistant(jobId: string, text: string): Message {
  return mockMessage({ conversationId, role: "assistant", jobId, content: { text } });
}

describe("streamed text", () => {
  it("accumulates deltas per job", () => {
    const jobId = mockId();
    const other = mockId();
    let drafts = appendDelta({}, { conversationId, jobId, text: "Here's " });
    drafts = appendDelta(drafts, { conversationId, jobId, text: "a hook" });
    drafts = appendDelta(drafts, { conversationId, jobId: other, text: "Elsewhere" });
    drafts = appendDelta(drafts, { conversationId, jobId, text: "" });

    expect(drafts[jobId]).toEqual({ jobId, conversationId, text: "Here's a hook" });
    expect(drafts[other]?.text).toBe("Elsewhere");
  });

  it("is replaced by the stored message of its job", () => {
    const jobId = mockId();
    const drafts = appendDelta({}, { conversationId, jobId, text: "Here's a hook" });

    expect(settleDraft(drafts, assistant(jobId, "Here's a hook"))).toEqual({});
    // The stored text wins even when the stream lost a chunk on the way.
    expect(settleDraft(drafts, assistant(jobId, "Here's a better hook"))).toEqual({});
  });

  it("keeps text streamed past the stored message as the start of the next one", () => {
    const jobId = mockId();
    const drafts = appendDelta({}, { conversationId, jobId, text: "First part.\n\nSecond" });

    expect(settleDraft(drafts, assistant(jobId, "First part."))[jobId]?.text).toBe("Second");
  });

  it("ignores user messages and other jobs", () => {
    const jobId = mockId();
    const drafts = appendDelta({}, { conversationId, jobId, text: "Streaming" });
    const user = mockMessage({ conversationId, role: "user", jobId, content: { text: "Hi" } });

    expect(settleDraft(drafts, user)).toBe(drafts);
    expect(settleDraft(drafts, assistant(mockId(), "Streaming"))).toBe(drafts);
  });

  it("notifies subscribers only when something changed", () => {
    const store = createConversationStore();
    const listener = vi.fn();
    store.subscribe(listener);
    const jobId = mockId();

    store.appendDelta({ conversationId, jobId, text: "Hello" });
    store.appendDelta({ conversationId, jobId, text: "" });
    store.clearDraft(mockId());
    expect(listener).toHaveBeenCalledTimes(1);

    store.settleDraft(assistant(jobId, "Hello"));
    expect(store.getState().drafts).toEqual({});
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("tracks the newest job of each conversation", () => {
    const store = createConversationStore();
    const newer = mockJob({ workspaceId, conversationId, createdAt: "2026-10-13T10:00:01.000Z" });
    const older = mockJob({ workspaceId, conversationId, createdAt: "2026-10-13T10:00:00.000Z" });

    store.trackJob(newer, "Write a hook");
    store.trackJob(older);

    expect(store.getState().jobs[conversationId]?.jobId).toBe(newer.id);
    expect(store.getState().prompts[newer.id]).toBe("Write a hook");
  });
});

describe("optimistic messages", () => {
  const clientMessageId = mockId();
  const pending: PendingMessage = {
    clientMessageId,
    conversationId,
    text: "Write a hook",
    status: "sending",
    createdAt: "2026-10-13T10:00:00.000Z",
    via: "keyboard",
  };

  it("show after the stored messages until the server stores them", () => {
    const earlier = mockMessage({
      conversationId,
      role: "assistant",
      content: { text: "Earlier" },
      createdAt: "2026-10-13T09:00:00.000Z",
    });
    const timeline = buildTimeline([earlier], [pending]);

    expect(timeline.map((item) => item.kind)).toEqual(["message", "pending"]);
    expect(timeline[1]?.key).toBe(clientMessageId);
  });

  it("are replaced by the stored message under the same key", () => {
    const stored = mockMessage({
      conversationId,
      role: "user",
      clientMessageId,
      content: { text: "Write a hook" },
    });
    const timeline = buildTimeline([stored], [pending], new Map([[clientMessageId, "pointer"]]));

    expect(timeline).toEqual([
      { kind: "message", key: clientMessageId, message: stored, enter: "pointer" },
    ]);
  });

  it("merge pages and live events without duplicates, oldest first", () => {
    const a = mockMessage({
      conversationId,
      role: "user",
      content: { text: "a" },
      createdAt: "2026-10-13T10:00:00.000Z",
    });
    const b = mockMessage({
      conversationId,
      role: "assistant",
      content: { text: "b" },
      createdAt: "2026-10-13T10:00:05.000Z",
    });
    const c = mockMessage({
      conversationId,
      role: "user",
      content: { text: "c" },
      createdAt: "2026-10-13T10:00:09.000Z",
    });

    expect(sortMessages([c, a, b, a]).map((m) => m.content.text)).toEqual(["a", "b", "c"]);
    expect(upsertMessage([a, c], b).map((m) => m.content.text)).toEqual(["a", "b", "c"]);
    expect(upsertMessage([a, b], { ...b, content: { text: "b2" } })).toHaveLength(2);
  });
});

describe("scroll pinning", () => {
  const at = (scrollTop: number, previousScrollTop = scrollTop) => ({
    scrollTop,
    previousScrollTop,
    scrollHeight: 2_000,
    clientHeight: 500,
  });

  it("follows at the end of the conversation", () => {
    expect(distanceFromBottom(at(1_500))).toBe(0);
    expect(nextPinned(false, at(1_500, 1_200))).toBe(true);
    // A few pixels short still counts as the end.
    expect(nextPinned(false, at(1_494, 1_400))).toBe(true);
  });

  it("stops following as soon as the reader scrolls up", () => {
    expect(nextPinned(true, at(1_400, 1_500))).toBe(false);
  });

  it("keeps its decision while content grows or the reader scrolls down short of the end", () => {
    // Content grew below a pinned view: the resize handler scrolls, not this.
    expect(nextPinned(true, at(1_300, 1_300))).toBe(true);
    expect(nextPinned(false, at(1_300, 1_000))).toBe(false);
  });
});

describe("job status", () => {
  const job = (status: JobSummary["status"], patch: Partial<JobSummary> = {}) =>
    mockJob({ workspaceId, conversationId, status, ...patch });

  it("maps every job state to the status line", () => {
    expect(describeJob(job("queued"), { studio: "online" })).toMatchObject({
      label: "Queued",
      active: true,
      canCancel: true,
      canRetry: false,
    });
    expect(describeJob(job("queued"), { studio: "offline" })).toMatchObject({
      label: "Waiting for studio agent (offline)",
      tone: "amber",
      canCancel: true,
    });
    expect(describeJob(job("queued"), { studio: "unpaired" }).label).toBe(
      "Waiting for studio agent (none paired)",
    );
    expect(describeJob(job("dispatched"), { studio: "online" })).toMatchObject({
      label: "Starting",
      canCancel: true,
    });
    expect(
      describeJob(job("running"), {
        studio: "online",
        activity: { kind: "Read", summary: "Reading PROJECT.md" },
      }),
    ).toMatchObject({ label: "Running", detail: "Reading PROJECT.md", tone: "violet" });
    expect(describeJob(job("running"), { studio: "online", streaming: true }).detail).toBe(
      "Writing the reply",
    );
    expect(describeJob(job("succeeded"), { studio: "online" })).toMatchObject({
      label: "Done",
      hidden: true,
      canCancel: false,
    });
    expect(
      describeJob(
        job("failed", { error: { code: "internal", message: "Disk full", retryable: true } }),
        { studio: "online" },
      ),
    ).toMatchObject({ label: "Failed", detail: "Disk full", canRetry: true, active: false });
    expect(
      describeJob(
        job("failed", { error: { code: "interrupted", message: "lease", retryable: false } }),
        { studio: "online" },
      ).detail,
    ).toMatch(/lost its connection/);
    expect(describeJob(job("cancelled"), { studio: "online" })).toMatchObject({
      label: "Cancelled",
      canRetry: true,
    });
  });

  it("shows a requested cancel until the job stops", () => {
    const view = describeJob(job("running", { cancelRequestedAt: "2026-10-13T10:00:00.000Z" }), {
      studio: "online",
    });
    expect(view).toMatchObject({ label: "Cancelling", canCancel: false });
  });

  it("never moves a cached job backwards", () => {
    const running = job("running");
    const queued = { ...running, status: "queued" as const };
    const done = { ...running, status: "succeeded" as const };

    expect(laterJob(running, queued)).toBe(running);
    expect(laterJob(running, done)).toBe(done);
    expect(laterJob(undefined, queued)).toBe(queued);
  });
});
