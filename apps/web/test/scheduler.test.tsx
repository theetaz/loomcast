import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { retryRefusal, taskKindLabel, taskTarget } from "@/features/scheduler-admin/queries";
import { ApiError } from "@/lib/api";
import { createMockDb, type MockDb } from "@/mocks/db";
import { killTask, mockTask } from "@/mocks/scheduler";
import { onlineStudio, recordRequests } from "./support/kb";
import { fakeStream } from "./support/live";
import { renderApp } from "./support/render";

const NOW = "2026-10-14T08:00:00.000Z";
const HOUR = 60 * 60_000;
const hoursAgo = (hours: number) => new Date(Date.parse(NOW) - hours * HOUR).toISOString();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
});
afterEach(() => {
  vi.useRealTimers();
});

const POST_ID = "6f1d2c3b-4a59-4e8f-9a7b-1c2d3e4f5a6b";
const CHANNEL_ID = "0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d";

/** A dead publish (newest), a dead channel check and a failed cadence run. */
function schedulerSetup() {
  const publish = mockTask({
    kind: "post.publish",
    runAt: hoursAgo(2),
    finishedAt: hoursAgo(2),
    payload: { postId: POST_ID },
    dedupeKey: `publish:${POST_ID}`,
    lastError: { code: "transient", message: "The platform did not answer.", at: hoursAgo(2) },
  });
  const verify = mockTask({
    kind: "channel.verify",
    runAt: hoursAgo(26),
    finishedAt: hoursAgo(26),
    attempts: 3,
    maxAttempts: 3,
    payload: { channelId: CHANNEL_ID },
    lastError: { code: "auth", message: "The access was revoked.", at: hoursAgo(26) },
  });
  const plan = mockTask({
    kind: "cadence.plan",
    status: "failed",
    runAt: hoursAgo(50),
    finishedAt: hoursAgo(50),
    attempts: 1,
    payload: {},
    lastError: { code: "invalid_payload", message: "No cadence to plan.", at: hoursAgo(50) },
  });
  const db: MockDb = createMockDb({
    signedIn: true,
    devices: [onlineStudio()],
    tasks: [verify, publish, plan],
    publisher: {
      mode: "dry-run",
      enabled: true,
      lastTickAt: new Date(Date.now() - 30_000).toISOString(),
    },
  });
  return { db, tasks: { publish, verify, plan } };
}

function taskRows() {
  const table = screen.getByRole("table");
  return within(table)
    .getAllByRole("row")
    .slice(1)
    .map((row) => row.getAttribute("data-task-id"));
}

describe("scheduler admin", () => {
  it("lists dead tasks newest first with their last error", async () => {
    const { db, tasks } = schedulerSetup();
    renderApp("/settings/scheduler", db);
    const table = await screen.findByRole("table", { name: "Dead tasks" }, { timeout: 5000 });
    expect(taskRows()).toEqual([tasks.publish.id, tasks.verify.id]);
    const publish = within(table).getAllByRole("row")[1] as HTMLElement;
    expect(within(publish).getByText("Publish a post")).toBeInTheDocument();
    expect(within(publish).getByText(`post ${POST_ID.slice(0, 8)}`)).toBeInTheDocument();
    expect(within(publish).getByText("5/5")).toBeInTheDocument();
    expect(within(publish).getByText("transient")).toBeInTheDocument();
    expect(within(publish).getByText("The platform did not answer.")).toBeInTheDocument();
    expect(screen.getByText(/The scheduler last ran/)).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/^Dry-run mode\./);
  });

  it("retries a dead task: it runs again and leaves the list", async () => {
    const { db, tasks } = schedulerSetup();
    const requests = recordRequests();
    const { user } = renderApp("/settings/scheduler", db);
    await screen.findByRole("table", { name: "Dead tasks" }, { timeout: 5000 });

    await user.click(screen.getByRole("button", { name: "Retry Publish a post" }));

    await waitFor(() => expect(taskRows()).toEqual([tasks.verify.id]));
    expect(requests.find((request) => request.method === "POST")?.path).toBe(
      `/api/scheduler/tasks/${tasks.publish.id}/retry`,
    );
    expect(db.tasks.find((task) => task.id === tasks.publish.id)).toMatchObject({
      status: "pending",
      attempts: 0,
    });
    expect(await screen.findByText("Task queued again")).toBeInTheDocument();
  });

  it("says why a retry was refused and reloads the list", async () => {
    const { db, tasks } = schedulerSetup();
    // Another run of the same publish is already waiting.
    db.tasks.push(
      mockTask({
        kind: "post.publish",
        status: "pending",
        runAt: hoursAgo(-1),
        payload: { postId: POST_ID },
        dedupeKey: `publish:${POST_ID}`,
        lastError: null,
        finishedAt: null,
      }),
    );
    const { user } = renderApp("/settings/scheduler", db);
    await screen.findByRole("table", { name: "Dead tasks" }, { timeout: 5000 });

    await user.click(screen.getByRole("button", { name: "Retry Publish a post" }));

    expect(await screen.findByText("Couldn't retry the task")).toBeInTheDocument();
    expect(
      screen.getByText("Another run of this task is already waiting or running."),
    ).toBeInTheDocument();
    expect(taskRows()).toContain(tasks.publish.id);
    expect(db.tasks.find((task) => task.id === tasks.publish.id)?.status).toBe("dead");
  });

  it("switches to failed tasks and keeps the view in the address", async () => {
    const { db, tasks } = schedulerSetup();
    const { user, router } = renderApp("/settings/scheduler", db);
    await screen.findByRole("table", { name: "Dead tasks" }, { timeout: 5000 });

    await user.click(screen.getByRole("button", { name: "Failed" }));
    await screen.findByRole("table", { name: "Failed tasks" });
    expect(taskRows()).toEqual([tasks.plan.id]);
    expect(screen.getByRole("button", { name: "Failed" })).toHaveAttribute("aria-pressed", "true");
    expect(router.state.location.search).toEqual({ status: "failed" });

    await user.click(screen.getByRole("button", { name: "Retry Plan cadence slots" }));
    expect(await screen.findByText("No failed tasks")).toBeInTheDocument();
  });

  it("adds a task to the list the moment the scheduler gives up on it", async () => {
    const { db, tasks } = schedulerSetup();
    const stream = fakeStream(db);
    renderApp("/settings/scheduler", db, [], { createEventSource: stream.factory });
    await screen.findByRole("table", { name: "Dead tasks" }, { timeout: 5000 });

    const refresh = mockTask({
      kind: "channel.refresh_token",
      status: "running",
      runAt: hoursAgo(0),
      payload: { channelId: CHANNEL_ID },
    });
    killTask(db, refresh);

    await waitFor(() =>
      expect(taskRows()).toEqual([refresh.id, tasks.publish.id, tasks.verify.id]),
    );
  });

  it("is a settings section", async () => {
    const { db } = schedulerSetup();
    renderApp("/settings/scheduler", db);
    expect(await screen.findByRole("tab", { name: "Scheduler" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });
});

describe("scheduler task helpers", () => {
  it("names a task's targets from the ids in its payload", () => {
    expect(taskTarget({ payload: { postId: POST_ID, since: NOW } })).toBe(
      `post ${POST_ID.slice(0, 8)}`,
    );
    expect(taskTarget({ payload: {} })).toBe("All");
    expect(taskKindLabel("insights.pull")).toBe("Pull post insights");
  });

  it("explains each kind of refusal", () => {
    const conflict = (details: unknown) => new ApiError(409, "conflict", "Refused.", details);
    expect(retryRefusal(conflict({ reason: "duplicate" }))).toBe(
      "Another run of this task is already waiting or running.",
    );
    expect(retryRefusal(conflict({ reason: "status", status: "running" }))).toBe(
      "Only failed or dead tasks can be retried. This one is running now.",
    );
    expect(retryRefusal(conflict(undefined))).toBe("Refused.");
    expect(retryRefusal(new Error("offline"))).toBeNull();
  });
});
