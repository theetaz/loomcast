import { randomUUID } from "node:crypto";
import {
  type LiveEventOf,
  RECURRING_TASK_INTERVAL_MS,
  type ScheduledTask,
  scheduledTaskRegistry,
} from "@loomcast/contracts";
import { auditLog, type ScheduledTaskRow, scheduledTasks } from "@loomcast/db";
import { createTestDb, type TestDb } from "@loomcast/db/testing";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ModuleDeps } from "../src/deps";
import { createEventBus } from "../src/lib/bus";
import { createLifecycle } from "../src/lib/lifecycle";
import { createLogger } from "../src/lib/logger";
import {
  createScheduler,
  recurringDedupeKey,
  type Scheduler,
  type SchedulerAlert,
  TaskFailure,
} from "../src/modules/scheduler";
import { startServer } from "../src/server";
import {
  createTestApp,
  createTestClock,
  errorCode,
  insertUser,
  login,
  send,
  type TestClock,
  testConfig,
} from "./support";

let testDb: TestDb;
const started: Scheduler[] = [];

beforeAll(async () => {
  testDb = await createTestDb({ max: 30 });
});

afterEach(async () => {
  await Promise.all(started.splice(0).map((scheduler) => scheduler.stop(1_000)));
  await testDb.db.delete(scheduledTasks);
});

afterAll(async () => {
  await testDb.drop();
});

interface Harness {
  scheduler: Scheduler;
  clock: TestClock;
  deadEvents: LiveEventOf<"task.dead">["payload"][];
  alerts: SchedulerAlert[];
  logs: string[];
}

function harness(
  options: { clock?: TestClock; workerId?: string; tickMs?: number; random?: () => number } = {},
): Harness {
  const logs: string[] = [];
  const logger = createLogger({
    level: "trace",
    destination: { write: (line: string) => void logs.push(line) },
  });
  const bus = createEventBus(logger);
  const deadEvents: LiveEventOf<"task.dead">["payload"][] = [];
  bus.subscribe("task.dead", (event) => void deadEvents.push(event.payload));
  const alerts: SchedulerAlert[] = [];
  const clock = options.clock ?? createTestClock(new Date("2026-10-13T08:00:00.000Z"));
  const scheduler = createScheduler({
    db: testDb.db,
    bus,
    clock,
    logger,
    config: { enabled: true, tickMs: options.tickMs ?? 5_000 },
    alert: (alert) => void alerts.push(alert),
    workerId: options.workerId ?? `test-${randomUUID()}`,
    // No jitter: every retry waits exactly base · 2^(attempt − 1).
    random: options.random ?? (() => 0.5),
  });
  started.push(scheduler);
  return { scheduler, clock, deadEvents, alerts, logs };
}

async function taskRow(id: string): Promise<ScheduledTaskRow> {
  const [row] = await testDb.db.select().from(scheduledTasks).where(eq(scheduledTasks.id, id));
  if (row === undefined) {
    throw new Error(`task ${id} not found`);
  }
  return row;
}

/** Claims and runs every task due now, until none is left. */
async function runDue(scheduler: Scheduler): Promise<void> {
  for (;;) {
    const claimed = await scheduler.tick();
    await scheduler.idle();
    if (claimed === 0) {
      return;
    }
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("claiming", () => {
  it("runs each of 100 tasks exactly once across two scheduler instances", async () => {
    const clock = createTestClock(new Date("2026-10-13T08:00:00.000Z"));
    const a = harness({ clock, workerId: "worker-a", tickMs: 10 });
    const b = harness({ clock, workerId: "worker-b", tickMs: 10 });
    const runs = new Map<string, number>();
    const byWorker = new Map<string, number>();
    for (const { scheduler } of [a, b]) {
      scheduler.register("post.publish", async ({ payload }) => {
        runs.set(payload.postId, (runs.get(payload.postId) ?? 0) + 1);
        byWorker.set(scheduler.workerId, (byWorker.get(scheduler.workerId) ?? 0) + 1);
        await new Promise((resolve) => setTimeout(resolve, 2));
      });
    }
    const postIds = Array.from({ length: 100 }, () => randomUUID());
    for (const postId of postIds) {
      await a.scheduler.enqueue("post.publish", { postId });
    }

    a.scheduler.start();
    b.scheduler.start();
    await vi.waitFor(
      async () => {
        const done = await testDb.db
          .select({ id: scheduledTasks.id })
          .from(scheduledTasks)
          .where(eq(scheduledTasks.status, "succeeded"));
        expect(done).toHaveLength(100);
      },
      { timeout: 20_000, interval: 50 },
    );
    await Promise.all([a.scheduler.stop(), b.scheduler.stop()]);

    expect(runs.size).toBe(100);
    for (const postId of postIds) {
      expect(runs.get(postId)).toBe(1);
    }
    expect((byWorker.get("worker-a") ?? 0) + (byWorker.get("worker-b") ?? 0)).toBe(100);
  });

  it("validates payloads on enqueue and skips tasks that are not due", async () => {
    const { scheduler, clock } = harness();
    const ran = vi.fn(async () => {});
    scheduler.register("post.publish", ran);
    await expect(
      scheduler.enqueue("post.publish", { postId: "not-a-uuid" } as { postId: string }),
    ).rejects.toThrow(/invalid payload/);

    const { task } = await scheduler.enqueue(
      "post.publish",
      { postId: randomUUID() },
      { runAt: new Date(clock.now().getTime() + 60_000) },
    );
    expect(await scheduler.tick()).toBe(0);
    clock.advance(60_000);
    await runDue(scheduler);
    expect(ran).toHaveBeenCalledOnce();
    expect((await taskRow(task.id)).status).toBe("succeeded");
  });

  it("enqueues in the caller's transaction", async () => {
    const { scheduler } = harness();
    const postId = randomUUID();
    await expect(
      testDb.db.transaction(async (tx) => {
        await scheduler.enqueue(tx, "post.publish", { postId }, { dedupeKey: `publish:${postId}` });
        throw new Error("roll back");
      }),
    ).rejects.toThrow("roll back");
    const rows = await testDb.db
      .select()
      .from(scheduledTasks)
      .where(eq(scheduledTasks.dedupeKey, `publish:${postId}`));
    expect(rows).toHaveLength(0);
  });

  it("schedules the next run when a handler returns `next`", async () => {
    const { scheduler, clock } = harness();
    const since = clock.now().toISOString();
    scheduler.register("post.check_status", async ({ now }) => ({
      next: new Date(now().getTime() + 15_000),
    }));
    const postId = randomUUID();
    const { task } = await scheduler.enqueue(
      "post.check_status",
      { postId, since },
      { dedupeKey: `status:${postId}` },
    );
    await runDue(scheduler);
    expect((await taskRow(task.id)).status).toBe("succeeded");
    const [next] = await testDb.db
      .select()
      .from(scheduledTasks)
      .where(
        and(eq(scheduledTasks.dedupeKey, `status:${postId}`), eq(scheduledTasks.status, "pending")),
      );
    expect(next).toMatchObject({
      kind: "post.check_status",
      payload: { postId, since },
      attempts: 0,
      runAt: new Date(clock.now().getTime() + 15_000),
    });
  });

  it("keeps recurring tasks queued and runs them every interval", async () => {
    const { scheduler, clock } = harness();
    const ran = vi.fn(async () => {});
    scheduler.register("assets.cleanup", ran);
    await scheduler.ensureRecurring();
    await scheduler.ensureRecurring();
    const queued = await testDb.db
      .select()
      .from(scheduledTasks)
      .where(eq(scheduledTasks.dedupeKey, recurringDedupeKey("assets.cleanup")));
    expect(queued).toHaveLength(1);
    // cadence.plan has no handler here, so it is not queued.
    const plans = await testDb.db
      .select()
      .from(scheduledTasks)
      .where(eq(scheduledTasks.kind, "cadence.plan"));
    expect(plans).toHaveLength(0);

    await runDue(scheduler);
    expect(ran).toHaveBeenCalledOnce();
    const [next] = await testDb.db
      .select()
      .from(scheduledTasks)
      .where(eq(scheduledTasks.status, "pending"));
    expect(next?.runAt).toEqual(new Date(clock.now().getTime() + RECURRING_TASK_INTERVAL_MS));
    expect(next?.dedupeKey).toBe(recurringDedupeKey("assets.cleanup"));
  });
});

describe("retries", () => {
  it("backs off exponentially with jitter on a fake clock", async () => {
    const { scheduler, clock } = harness();
    const attempts: number[] = [];
    scheduler.register("post.publish", async ({ attempt }) => {
      attempts.push(attempt);
      throw new TaskFailure("platform_unavailable", "The platform did not answer");
    });
    const base = scheduledTaskRegistry["post.publish"].backoffBaseMs;
    const { task } = await scheduler.enqueue("post.publish", { postId: randomUUID() });

    await runDue(scheduler);
    let row = await taskRow(task.id);
    expect(row).toMatchObject({ status: "pending", attempts: 1 });
    expect(row.lastError).toMatchObject({ code: "platform_unavailable" });
    expect(row.runAt.getTime() - clock.now().getTime()).toBe(base);

    clock.advance(base - 1);
    expect(await scheduler.tick()).toBe(0);
    clock.advance(1);
    await runDue(scheduler);
    row = await taskRow(task.id);
    expect(row).toMatchObject({ status: "pending", attempts: 2 });
    expect(row.runAt.getTime() - clock.now().getTime()).toBe(base * 2);

    clock.advance(base * 2);
    await runDue(scheduler);
    row = await taskRow(task.id);
    expect(row.runAt.getTime() - clock.now().getTime()).toBe(base * 4);
    expect(attempts).toEqual([1, 2, 3]);
  });

  it("varies the delay by at most 20% and honours retryAfterMs", async () => {
    const low = harness({ random: () => 0 });
    low.scheduler.register("post.publish", async () => {
      throw new TaskFailure("busy", "Busy");
    });
    const { task } = await low.scheduler.enqueue("post.publish", { postId: randomUUID() });
    await runDue(low.scheduler);
    const base = scheduledTaskRegistry["post.publish"].backoffBaseMs;
    expect((await taskRow(task.id)).runAt.getTime() - low.clock.now().getTime()).toBe(base * 0.8);
    await low.scheduler.stop();

    const custom = harness();
    custom.scheduler.register("post.publish", async () => {
      throw new TaskFailure("rate_limited", "Slow down", { retryAfterMs: 900_000 });
    });
    const second = await custom.scheduler.enqueue("post.publish", { postId: randomUUID() });
    await runDue(custom.scheduler);
    expect((await taskRow(second.task.id)).runAt.getTime() - custom.clock.now().getTime()).toBe(
      900_000,
    );
  });

  it("fails at once on a non-retryable failure", async () => {
    const { scheduler, alerts, deadEvents } = harness();
    scheduler.register("post.publish", async () => {
      throw new TaskFailure("invalid_media", "The video is too long", { retryable: false });
    });
    const { task } = await scheduler.enqueue("post.publish", { postId: randomUUID() });
    await runDue(scheduler);
    expect(await taskRow(task.id)).toMatchObject({ status: "failed", attempts: 1 });
    expect(alerts.map((alert) => alert.key)).toEqual([`task.failed:${task.id}`]);
    expect(deadEvents).toHaveLength(0);
  });

  it("stores a generic message for unexpected errors", async () => {
    const { scheduler } = harness();
    const secret = `token-${randomUUID()}`;
    scheduler.register("post.publish", async () => {
      throw new Error(`request failed for ${secret}`);
    });
    const { task } = await scheduler.enqueue("post.publish", { postId: randomUUID() });
    await runDue(scheduler);
    const row = await taskRow(task.id);
    expect(row.lastError?.code).toBe("handler_error");
    expect(JSON.stringify(row.lastError)).not.toContain(secret);
  });
});

describe("dead letters", () => {
  it("dead-letters a task after its last attempt with an audit row, event and alert", async () => {
    const { scheduler, clock, deadEvents, alerts } = harness();
    scheduler.register("assets.cleanup", async () => {
      throw new TaskFailure("storage_down", "Object storage did not answer");
    });
    const { task } = await scheduler.enqueue("assets.cleanup", {});
    const { maxAttempts } = scheduledTaskRegistry["assets.cleanup"];
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      await runDue(scheduler);
      clock.advance(60 * 60_000);
    }
    const row = await taskRow(task.id);
    expect(row).toMatchObject({ status: "dead", attempts: maxAttempts });
    expect(row.finishedAt).not.toBeNull();

    expect(deadEvents).toHaveLength(1);
    expect(deadEvents[0]?.task).toMatchObject({
      id: task.id,
      kind: "assets.cleanup",
      status: "dead",
      lastError: { code: "storage_down" },
    });
    expect(alerts.map((alert) => alert.key)).toEqual([`task.dead:${task.id}`]);
    const audits = await testDb.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.targetId, task.id), eq(auditLog.action, "scheduler.task.dead")));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorKind: "system", targetType: "scheduled_task" });
  });

  it("dead-letters a run whose lease expired on its last attempt", async () => {
    const { scheduler, clock, deadEvents } = harness();
    scheduler.register("post.publish", async () => {});
    const { task } = await scheduler.enqueue("post.publish", { postId: randomUUID() });
    await testDb.db
      .update(scheduledTasks)
      .set({
        status: "running",
        attempts: task.maxAttempts,
        lockedBy: "crashed-worker",
        lockedUntil: new Date(clock.now().getTime() - 1_000),
      })
      .where(eq(scheduledTasks.id, task.id));
    expect(await scheduler.tick()).toBe(0);
    expect(await taskRow(task.id)).toMatchObject({
      status: "dead",
      lastError: { code: "lease_expired" },
    });
    expect(deadEvents.map((event) => event.task.id)).toEqual([task.id]);
  });

  it("takes over a run whose lease expired while attempts remain", async () => {
    const { scheduler, clock } = harness();
    const ran = vi.fn(async () => {});
    scheduler.register("post.publish", ran);
    const { task } = await scheduler.enqueue("post.publish", { postId: randomUUID() });
    await testDb.db
      .update(scheduledTasks)
      .set({
        status: "running",
        attempts: 1,
        lockedBy: "crashed-worker",
        lockedUntil: new Date(clock.now().getTime() - 1),
      })
      .where(eq(scheduledTasks.id, task.id));
    await runDue(scheduler);
    expect(ran).toHaveBeenCalledOnce();
    expect(await taskRow(task.id)).toMatchObject({ status: "succeeded", attempts: 2 });
  });
});

describe("leases", () => {
  it("extends the lease every leaseMs / 2 while the handler runs", async () => {
    const clock = createTestClock(new Date("2026-10-13T08:00:00.000Z"));
    const { scheduler } = harness({ clock });
    const other = harness({ clock });
    other.scheduler.register("post.publish", async () => {});
    const release = deferred();
    const leaseMs = 300;
    scheduler.register("post.publish", () => release.promise, { leaseMs });
    const { task } = await scheduler.enqueue("post.publish", { postId: randomUUID() });

    expect(await scheduler.tick()).toBe(1);
    await vi.waitFor(async () => {
      expect((await taskRow(task.id)).lockedUntil?.getTime()).toBe(clock.now().getTime() + leaseMs);
    });

    // Without renewals the lease would have run out by now.
    clock.advance(10_000);
    await vi.waitFor(
      async () => {
        expect((await taskRow(task.id)).lockedUntil?.getTime()).toBe(
          clock.now().getTime() + leaseMs,
        );
      },
      { timeout: 5_000, interval: 20 },
    );
    expect(await other.scheduler.tick()).toBe(0);

    release.resolve();
    await scheduler.idle();
    expect(await taskRow(task.id)).toMatchObject({
      status: "succeeded",
      attempts: 1,
      lockedBy: null,
    });
  });

  it("aborts the handler when the lease is lost and drops its outcome", async () => {
    const { scheduler } = harness();
    let signal: AbortSignal | undefined;
    const release = deferred();
    scheduler.register(
      "post.publish",
      async (context) => {
        signal = context.signal;
        await release.promise;
      },
      { leaseMs: 200 },
    );
    const { task } = await scheduler.enqueue("post.publish", { postId: randomUUID() });
    await scheduler.tick();
    await vi.waitFor(() => expect(signal).toBeDefined());
    await testDb.db
      .update(scheduledTasks)
      .set({ lockedBy: "another-worker" })
      .where(eq(scheduledTasks.id, task.id));
    await vi.waitFor(() => expect(signal?.aborted).toBe(true), { timeout: 5_000 });
    await scheduler.idle();
    release.resolve();
    expect(await taskRow(task.id)).toMatchObject({
      status: "running",
      lockedBy: "another-worker",
    });
  });
});

describe("stopping", () => {
  it("waits for running handlers to finish", async () => {
    const { scheduler } = harness({ tickMs: 20 });
    let finished = false;
    scheduler.register("post.publish", async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      finished = true;
    });
    const { task } = await scheduler.enqueue("post.publish", { postId: randomUUID() });
    scheduler.start();
    await vi.waitFor(async () => expect((await taskRow(task.id)).status).toBe("running"));
    await scheduler.stop(5_000);
    expect(finished).toBe(true);
    expect((await taskRow(task.id)).status).toBe("succeeded");
    expect(scheduler.health()).toMatchObject({ status: "stopped", running: false });
  });

  it("aborts handlers that outlive the timeout and releases their tasks", async () => {
    const { scheduler, clock } = harness();
    let signal: AbortSignal | undefined;
    // Ignores its signal on purpose: the task must still be released.
    scheduler.register("post.publish", async (context) => {
      signal = context.signal;
      await new Promise(() => {});
    });
    const { task } = await scheduler.enqueue("post.publish", { postId: randomUUID() });
    await scheduler.tick();
    await vi.waitFor(() => expect(signal).toBeDefined());
    await scheduler.stop(100);
    expect(signal?.aborted).toBe(true);
    const row = await taskRow(task.id);
    expect(row).toMatchObject({
      status: "pending",
      attempts: 1,
      lockedBy: null,
      lastError: { code: "interrupted" },
    });
    expect(row.runAt).toEqual(clock.now());
    // A stopped scheduler claims nothing.
    expect(await scheduler.tick()).toBe(0);
  });
});

describe("health", () => {
  it("reports the loop state and queue depths", async () => {
    const { scheduler, clock } = harness({ tickMs: 1_000 });
    expect(scheduler.health()).toMatchObject({ status: "stopped", running: false, inFlight: 0 });
    scheduler.register("post.publish", async () => {});
    scheduler.start();
    await vi.waitFor(() => expect(scheduler.health().lastTickAt).not.toBeNull());
    expect(scheduler.health()).toMatchObject({
      status: "ok",
      running: true,
      registeredKinds: ["post.publish"],
    });
    clock.advance(10 * 60_000);
    expect(scheduler.health().status).toBe("stalled");

    await scheduler.enqueue(
      "post.publish",
      { postId: randomUUID() },
      {
        runAt: new Date(clock.now().getTime() + 3_600_000),
      },
    );
    expect(await scheduler.queueDepths()).toEqual({
      pending: 1,
      running: 0,
      succeeded: 0,
      failed: 0,
      dead: 0,
    });
  });
});

describe("app wiring", () => {
  it("registers the asset cleanup and runs the loop only under startServer", async () => {
    let moduleDeps: ModuleDeps | undefined;
    createTestApp(testDb.db, {
      modules: [
        (app, deps) => {
          moduleDeps = deps;
          return app;
        },
      ],
    });
    expect(moduleDeps?.scheduler.hasHandler("assets.cleanup")).toBe(true);
    expect(moduleDeps?.scheduler.health().running).toBe(false);

    const logger = createLogger({ level: "silent" });
    const lifecycle = createLifecycle(logger);
    const running = await startServer(
      {
        db: testDb.db,
        bus: createEventBus(logger),
        clock: createTestClock(),
        logger,
        config: testConfig({ scheduler: { enabled: true, tickMs: 50 } }),
        lifecycle,
      },
      { port: 0, host: "127.0.0.1" },
    );
    try {
      await vi.waitFor(
        async () => {
          const rows = await testDb.db
            .select()
            .from(scheduledTasks)
            .where(eq(scheduledTasks.dedupeKey, recurringDedupeKey("assets.cleanup")));
          expect(rows.map((row) => row.status).sort()).toEqual(["pending", "succeeded"]);
        },
        { timeout: 10_000, interval: 50 },
      );
    } finally {
      await running.close();
    }
  });
});

describe("admin endpoints", () => {
  async function seed(scheduler: Scheduler, clock: TestClock) {
    const dead = await scheduler.enqueue("post.publish", { postId: randomUUID() });
    const failed = await scheduler.enqueue("assets.cleanup", {}, { dedupeKey: "cleanup:test" });
    const pending = await scheduler.enqueue(
      "post.publish",
      { postId: randomUUID() },
      { runAt: new Date(clock.now().getTime() + 60_000) },
    );
    await testDb.db
      .update(scheduledTasks)
      .set({
        status: "dead",
        attempts: 5,
        finishedAt: clock.now(),
        lastError: { code: "boom", message: "Failed", at: clock.now().toISOString() },
      })
      .where(eq(scheduledTasks.id, dead.task.id));
    await testDb.db
      .update(scheduledTasks)
      .set({ status: "failed", attempts: 1, finishedAt: clock.now() })
      .where(eq(scheduledTasks.id, failed.task.id));
    return { dead: dead.task, failed: failed.task, pending: pending.task };
  }

  it("lists tasks by status and kind with paging, for signed-in admins only", async () => {
    let scheduler: Scheduler | undefined;
    const { app, clock } = createTestApp(testDb.db, {
      modules: [
        (target, deps) => {
          scheduler = deps.scheduler;
          return target;
        },
      ],
    });
    if (scheduler === undefined) throw new Error("no scheduler");
    const tasks = await seed(scheduler, clock);
    const user = await insertUser(testDb.db, { role: "admin" });
    const { cookie } = await login(app, user.email);

    expect((await send(app, "GET", "/api/scheduler/tasks")).status).toBe(401);

    const dead = await send(app, "GET", "/api/scheduler/tasks?status=dead", { cookie });
    expect(dead.status).toBe(200);
    expect(dead.headers.get("cache-control")).toBe("no-store");
    const deadBody = (await dead.json()) as { items: ScheduledTask[]; nextCursor: string | null };
    expect(deadBody.items.map((task) => task.id)).toEqual([tasks.dead.id]);
    expect(deadBody.items[0]).toMatchObject({
      kind: "post.publish",
      status: "dead",
      lastError: { code: "boom" },
    });
    expect(deadBody.items[0]).not.toHaveProperty("lockedBy");

    const byKind = await send(app, "GET", "/api/scheduler/tasks?kind=assets.cleanup", { cookie });
    expect(((await byKind.json()) as { items: ScheduledTask[] }).items).toHaveLength(1);

    const first = await send(app, "GET", "/api/scheduler/tasks?limit=2", { cookie });
    const firstBody = (await first.json()) as { items: ScheduledTask[]; nextCursor: string };
    expect(firstBody.items.map((task) => task.id)[0]).toBe(tasks.pending.id);
    expect(firstBody.nextCursor).not.toBeNull();
    const second = await send(
      app,
      "GET",
      `/api/scheduler/tasks?limit=2&cursor=${firstBody.nextCursor}`,
      { cookie },
    );
    const secondBody = (await second.json()) as { items: ScheduledTask[]; nextCursor: null };
    expect(secondBody.nextCursor).toBeNull();
    expect([...firstBody.items, ...secondBody.items].map((task) => task.id).sort()).toEqual(
      [tasks.dead.id, tasks.failed.id, tasks.pending.id].sort(),
    );

    const bad = await send(app, "GET", "/api/scheduler/tasks?status=sleeping", { cookie });
    expect(await errorCode(bad)).toBe("validation_failed");
    const badCursor = await send(app, "GET", "/api/scheduler/tasks?cursor=nope", { cookie });
    expect(await errorCode(badCursor)).toBe("validation_failed");
  });

  it("retries failed and dead tasks, and refuses the rest", async () => {
    let scheduler: Scheduler | undefined;
    const { app, clock } = createTestApp(testDb.db, {
      modules: [
        (target, deps) => {
          scheduler = deps.scheduler;
          return target;
        },
      ],
    });
    if (scheduler === undefined) throw new Error("no scheduler");
    const tasks = await seed(scheduler, clock);
    const owner = await insertUser(testDb.db, { role: "owner" });
    const { cookie } = await login(app, owner.email);

    const retried = await send(app, "POST", `/api/scheduler/tasks/${tasks.dead.id}/retry`, {
      cookie,
    });
    expect(retried.status).toBe(200);
    expect(await retried.json()).toMatchObject({
      id: tasks.dead.id,
      status: "pending",
      attempts: 0,
      runAt: clock.now().toISOString(),
    });
    const audits = await testDb.db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.targetId, tasks.dead.id), eq(auditLog.action, "scheduler.task.retried")),
      );
    expect(audits[0]).toMatchObject({ actorKind: "user", actorId: owner.id });

    const again = await send(app, "POST", `/api/scheduler/tasks/${tasks.dead.id}/retry`, {
      cookie,
    });
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({
      error: { code: "conflict", details: { reason: "status", status: "pending" } },
    });

    // Another task took the failed task's dedupe key in the meantime.
    await scheduler.enqueue("assets.cleanup", {}, { dedupeKey: "cleanup:test" });
    const taken = await send(app, "POST", `/api/scheduler/tasks/${tasks.failed.id}/retry`, {
      cookie,
    });
    expect(taken.status).toBe(409);
    expect(await taken.json()).toMatchObject({ error: { details: { reason: "duplicate" } } });

    const missing = await send(app, "POST", `/api/scheduler/tasks/${randomUUID()}/retry`, {
      cookie,
    });
    expect(missing.status).toBe(404);

    const crossSite = await send(app, "POST", `/api/scheduler/tasks/${tasks.failed.id}/retry`, {
      cookie,
      origin: "https://evil.example.test",
    });
    expect(crossSite.status).toBe(403);
  });
});
