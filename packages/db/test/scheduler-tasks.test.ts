import { randomUUID } from "node:crypto";
import { type TaskError, TaskErrorSchema } from "@loomcast/contracts";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type DbHandle } from "../src/client";
import {
  claimDueTasks,
  completeTask,
  enqueueTask,
  extendLease,
  retryTask,
  TASK_ATTEMPTS_EXHAUSTED_CODE,
  TASK_LEASE_EXPIRED_CODE,
  taskLease,
} from "../src/queries/scheduler";
import { scheduledTasks } from "../src/schema";
import { createTestDb, type TestDb } from "../src/testing";
import { PG, pgError } from "./fixtures";

let testDb: TestDb;

beforeAll(async () => {
  testDb = await createTestDb();
});

afterAll(async () => {
  await testDb.drop();
});

const MINUTE = 60_000;

/**
 * The tests share one database, so each claims at its own fake time, a year earlier than the test
 * before it and long after the real clock. Tasks a test leaves behind are then never due (nor their
 * leases expired) in a later test, including the one that uses the database clock.
 */
let clockBase = Date.UTC(2200, 0, 1);
function testClock(): Date {
  clockBase -= 365 * 24 * 60 * MINUTE;
  return new Date(clockBase);
}

/** A run time no test reaches. */
const NEVER = new Date(Date.UTC(2300, 0, 1));

function later(from: Date, ms: number): Date {
  return new Date(from.getTime() + ms);
}

function taskError(code: string, at: Date): TaskError {
  return { code, message: `Failed with ${code}`, at: at.toISOString() };
}

/** Claims everything due at `now` as `workerId`, a few at a time, until nothing is left. */
async function drain(db: TestDb["db"], workerId: string, now: Date) {
  const ids: string[] = [];
  for (;;) {
    const { claimed } = await claimDueTasks(db, { limit: 7, workerId, leaseMs: MINUTE, now });
    if (claimed.length === 0) return ids;
    ids.push(...claimed.map((task) => task.id));
  }
}

async function getTask(id: string) {
  const [task] = await testDb.db.select().from(scheduledTasks).where(eq(scheduledTasks.id, id));
  if (task === undefined) throw new Error("expected the task");
  return task;
}

describe("enqueueTask", () => {
  it("inserts a pending task with no attempts", async () => {
    const now = testClock();
    const { task, created } = await enqueueTask(testDb.db, {
      kind: "post.publish",
      payload: { postId: randomUUID() },
      runAt: now,
      maxAttempts: 5,
    });

    expect(created).toBe(true);
    expect(task).toMatchObject({
      kind: "post.publish",
      status: "pending",
      attempts: 0,
      maxAttempts: 5,
      runAt: now,
      dedupeKey: null,
      lockedBy: null,
      lockedUntil: null,
      finishedAt: null,
    });
  });

  it("dedupes on the key: a pending duplicate is rescheduled, not inserted", async () => {
    const now = testClock();
    const dedupeKey = `publish:${randomUUID()}`;
    const first = await enqueueTask(testDb.db, {
      kind: "post.publish",
      payload: { postId: "a" },
      runAt: now,
      maxAttempts: 5,
      dedupeKey,
    });
    const second = await enqueueTask(testDb.db, {
      kind: "post.publish",
      payload: { postId: "b" },
      runAt: later(now, 10 * MINUTE),
      maxAttempts: 5,
      dedupeKey,
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.task.id).toBe(first.task.id);
    expect(second.task).toMatchObject({ payload: { postId: "b" }, runAt: later(now, 10 * MINUTE) });

    const kept = await enqueueTask(testDb.db, {
      kind: "post.publish",
      payload: { postId: "c" },
      runAt: later(now, 20 * MINUTE),
      maxAttempts: 5,
      dedupeKey,
      onDuplicate: "keep",
    });
    expect(kept).toMatchObject({
      created: false,
      task: { id: first.task.id, payload: { postId: "b" } },
    });

    const rows = await testDb.db
      .select()
      .from(scheduledTasks)
      .where(eq(scheduledTasks.dedupeKey, dedupeKey));
    expect(rows).toHaveLength(1);
  });

  it("leaves a running duplicate alone and reuses the key once the task has finished", async () => {
    const now = testClock();
    const dedupeKey = `produce:${randomUUID()}`;
    const { task } = await enqueueTask(testDb.db, {
      kind: "cadence.produce",
      payload: { itemId: "x" },
      runAt: now,
      maxAttempts: 5,
      dedupeKey,
    });
    const { claimed } = await claimDueTasks(testDb.db, {
      limit: 10,
      workerId: "w1",
      leaseMs: MINUTE,
      now,
    });
    expect(claimed.map((row) => row.id)).toEqual([task.id]);

    const duplicate = await enqueueTask(testDb.db, {
      kind: "cadence.produce",
      payload: { itemId: "y" },
      runAt: later(now, MINUTE),
      maxAttempts: 5,
      dedupeKey,
    });
    expect(duplicate).toMatchObject({
      created: false,
      task: { id: task.id, status: "running", payload: { itemId: "x" }, runAt: now },
    });

    await completeTask(testDb.db, taskLease(claimed[0] ?? task, "w1"), { status: "succeeded" });
    const next = await enqueueTask(testDb.db, {
      kind: "cadence.produce",
      payload: { itemId: "z" },
      runAt: later(now, MINUTE),
      maxAttempts: 5,
      dedupeKey,
    });
    expect(next.created).toBe(true);
    expect(next.task.id).not.toBe(task.id);
  });

  it("is backed by a unique index over pending and running tasks only", async () => {
    const dedupeKey = `plan:${randomUUID()}`;
    const values = { kind: "cadence.plan", dedupeKey, maxAttempts: 3, runAt: NEVER };
    await testDb.db.insert(scheduledTasks).values({ ...values, status: "succeeded" });
    await testDb.db.insert(scheduledTasks).values({ ...values, status: "dead" });
    await testDb.db.insert(scheduledTasks).values(values);

    expect(await pgError(testDb.db.insert(scheduledTasks).values(values))).toEqual({
      code: PG.uniqueViolation,
      constraint: "scheduled_tasks_dedupe_key_uq",
    });
  });
});

describe("claimDueTasks", () => {
  it("claims due pending tasks oldest first under a lease, leaving future ones", async () => {
    const now = testClock();
    const ids: string[] = [];
    for (const offset of [-3, -1, -2]) {
      const { task } = await enqueueTask(testDb.db, {
        kind: "assets.cleanup",
        payload: {},
        runAt: later(now, offset * MINUTE),
        maxAttempts: 3,
      });
      ids.push(task.id);
    }
    const { task: future } = await enqueueTask(testDb.db, {
      kind: "assets.cleanup",
      payload: {},
      runAt: later(now, MINUTE),
      maxAttempts: 3,
    });

    const first = await claimDueTasks(testDb.db, {
      limit: 2,
      workerId: "w1",
      leaseMs: 5 * MINUTE,
      now,
    });
    expect(first.claimed.map((task) => task.id)).toEqual([ids[0], ids[2]]);
    expect(first.deadLettered).toEqual([]);
    for (const task of first.claimed) {
      expect(task).toMatchObject({
        status: "running",
        attempts: 1,
        lockedBy: "w1",
        lockedUntil: later(now, 5 * MINUTE),
      });
    }

    const second = await claimDueTasks(testDb.db, {
      limit: 10,
      workerId: "w2",
      leaseMs: 5 * MINUTE,
      now,
    });
    expect(second.claimed.map((task) => task.id)).toEqual([ids[1]]);
    expect((await getTask(future.id)).status).toBe("pending");
  });

  it("never hands the same task to two concurrent claimers (200 tasks)", async () => {
    const now = testClock();
    const { claimed: leftovers } = await claimDueTasks(testDb.db, {
      limit: 1,
      workerId: "probe",
      leaseMs: MINUTE,
      now,
    });
    expect(leftovers).toEqual([]);

    await testDb.db.insert(scheduledTasks).values(
      Array.from({ length: 200 }, (_, index) => ({
        kind: "post.publish",
        payload: { index },
        runAt: later(now, -(index % 13) * 1000),
        maxAttempts: 5,
      })),
    );
    const handles: DbHandle[] = [
      createDb(testDb.url, { max: 2 }),
      createDb(testDb.url, { max: 2 }),
    ];
    try {
      // Open the connections first, so both claimers start together.
      await Promise.all(handles.map((handle) => handle.db.execute(sql`select 1`)));
      const [a, b] = await Promise.all([
        drain(handles[0]?.db ?? testDb.db, "worker-a", now),
        drain(handles[1]?.db ?? testDb.db, "worker-b", now),
      ]);

      const overlap = a.filter((id) => b.includes(id));
      expect(overlap).toEqual([]);
      expect(new Set([...a, ...b]).size).toBe(200);
      expect(a.length + b.length).toBe(200);
      expect(a.length).toBeGreaterThan(0);
      expect(b.length).toBeGreaterThan(0);

      const rows = await testDb.db
        .select()
        .from(scheduledTasks)
        .where(inArray(scheduledTasks.id, [...a, ...b]));
      expect(rows.every((row) => row.status === "running" && row.attempts === 1)).toBe(true);
      const owner = new Map(rows.map((row) => [row.id, row.lockedBy]));
      expect(a.every((id) => owner.get(id) === "worker-a")).toBe(true);
      expect(b.every((id) => owner.get(id) === "worker-b")).toBe(true);
    } finally {
      await Promise.all(handles.map((handle) => handle.close()));
    }
  });

  it("reclaims a running task whose lease ran out, and the old run loses it", async () => {
    const now = testClock();
    const { task } = await enqueueTask(testDb.db, {
      kind: "post.publish",
      payload: {},
      runAt: now,
      maxAttempts: 3,
    });
    const [run1] = (
      await claimDueTasks(testDb.db, { limit: 10, workerId: "w1", leaseMs: MINUTE, now })
    ).claimed;
    if (run1 === undefined) throw new Error("expected a claim");

    // Within the lease nobody else gets it.
    const during = later(now, 30_000);
    expect(
      (await claimDueTasks(testDb.db, { limit: 10, workerId: "w2", leaseMs: MINUTE, now: during }))
        .claimed,
    ).toEqual([]);

    const after = later(now, 2 * MINUTE);
    const { claimed, deadLettered } = await claimDueTasks(testDb.db, {
      limit: 10,
      workerId: "w2",
      leaseMs: MINUTE,
      now: after,
    });
    expect(deadLettered).toEqual([]);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({
      id: task.id,
      status: "running",
      attempts: 2,
      lockedBy: "w2",
      lockedUntil: later(after, MINUTE),
    });

    // The first run can neither renew nor finish the task any more.
    const staleLease = taskLease(run1, "w1");
    expect(await extendLease(testDb.db, { ...staleLease, leaseMs: MINUTE, now: after })).toBeNull();
    expect(await completeTask(testDb.db, staleLease, { status: "succeeded" })).toBeNull();
    expect(await getTask(task.id)).toMatchObject({ status: "running", lockedBy: "w2" });

    // The same worker reclaiming its own task is a new run too.
    const third = later(after, 2 * MINUTE);
    const [run3] = (
      await claimDueTasks(testDb.db, { limit: 10, workerId: "w2", leaseMs: MINUTE, now: third })
    ).claimed;
    expect(run3?.attempts).toBe(3);
    const run2Lease = taskLease(claimed[0] ?? task, "w2");
    expect(await completeTask(testDb.db, run2Lease, { status: "succeeded" })).toBeNull();
  });

  it("dead-letters an expired run with no attempt left instead of claiming it", async () => {
    const now = testClock();
    const { task } = await enqueueTask(testDb.db, {
      kind: "cadence.plan",
      payload: {},
      runAt: now,
      maxAttempts: 1,
    });
    await claimDueTasks(testDb.db, { limit: 10, workerId: "w1", leaseMs: MINUTE, now });

    const after = later(now, 2 * MINUTE);
    const { claimed, deadLettered } = await claimDueTasks(testDb.db, {
      limit: 10,
      workerId: "w2",
      leaseMs: MINUTE,
      now: after,
    });

    expect(claimed).toEqual([]);
    expect(deadLettered).toHaveLength(1);
    expect(deadLettered[0]).toMatchObject({
      id: task.id,
      status: "dead",
      attempts: 1,
      lockedBy: null,
      lockedUntil: null,
      finishedAt: after,
      lastError: { code: TASK_LEASE_EXPIRED_CODE, at: after.toISOString() },
    });
    expect(TaskErrorSchema.safeParse(deadLettered[0]?.lastError).success).toBe(true);
  });

  it("dead-letters a due pending task that is already at its attempt limit", async () => {
    const now = testClock();
    const [task] = await testDb.db
      .insert(scheduledTasks)
      .values({ kind: "cadence.plan", runAt: now, attempts: 2, maxAttempts: 2 })
      .returning();
    const { claimed, deadLettered } = await claimDueTasks(testDb.db, {
      limit: 10,
      workerId: "w1",
      leaseMs: MINUTE,
      now,
    });

    expect(claimed).toEqual([]);
    expect(deadLettered.map((row) => [row.id, row.status, row.lastError?.code])).toEqual([
      [task?.id, "dead", TASK_ATTEMPTS_EXHAUSTED_CODE],
    ]);
  });

  it("works with the database clock when no time is given", async () => {
    const { task } = await enqueueTask(testDb.db, {
      kind: "post.check_status",
      payload: {},
      maxAttempts: 2,
      dedupeKey: `check:${randomUUID()}`,
    });
    // Tasks of the other tests run long after the real clock, so only this one is due.
    const { claimed } = await claimDueTasks(testDb.db, {
      limit: 10,
      workerId: "w1",
      leaseMs: MINUTE,
    });
    expect(claimed.map((row) => row.id)).toEqual([task.id]);
    const lockedUntil = claimed[0]?.lockedUntil?.getTime() ?? 0;
    expect(lockedUntil - Date.now()).toBeGreaterThan(MINUTE - 30_000);
    expect(lockedUntil - Date.now()).toBeLessThanOrEqual(MINUTE + 30_000);
    const renewed = await extendLease(testDb.db, {
      ...taskLease(task, "w1"),
      attempt: 1,
      leaseMs: 2 * MINUTE,
    });
    expect(renewed?.getTime()).toBeGreaterThan(lockedUntil);
    await completeTask(
      testDb.db,
      { id: task.id, workerId: "w1", attempt: 1 },
      {
        status: "succeeded",
      },
    );
  });
});

describe("extendLease and completeTask", () => {
  async function claimOne(maxAttempts = 3) {
    const now = testClock();
    const { task } = await enqueueTask(testDb.db, {
      kind: "post.publish",
      payload: {},
      runAt: now,
      maxAttempts,
    });
    const [claimed] = (
      await claimDueTasks(testDb.db, { limit: 10, workerId: "w1", leaseMs: MINUTE, now })
    ).claimed;
    expect(claimed?.id).toBe(task.id);
    return { now, task: claimed ?? task };
  }

  it("extends the lease of the run that holds it", async () => {
    const { now, task } = await claimOne();
    const at = later(now, 40_000);
    const lockedUntil = await extendLease(testDb.db, {
      ...taskLease(task, "w1"),
      leaseMs: MINUTE,
      now: at,
    });

    expect(lockedUntil).toEqual(later(at, MINUTE));
    // Still held at the original expiry.
    const { claimed } = await claimDueTasks(testDb.db, {
      limit: 10,
      workerId: "w2",
      leaseMs: MINUTE,
      now: later(now, MINUTE + 1000),
    });
    expect(claimed).toEqual([]);
    expect(
      await extendLease(testDb.db, { ...taskLease(task, "w2"), leaseMs: MINUTE, now: at }),
    ).toBeNull();
  });

  it("records success and releases the lease", async () => {
    const { now, task } = await claimOne();
    const done = await completeTask(
      testDb.db,
      { ...taskLease(task, "w1"), now: later(now, 1000) },
      { status: "succeeded" },
    );

    expect(done).toMatchObject({
      status: "succeeded",
      lockedBy: null,
      lockedUntil: null,
      finishedAt: later(now, 1000),
    });
  });

  it("schedules a retry, which the next claim counts as the next attempt", async () => {
    const { now, task } = await claimOne();
    const error = taskError("transient", now);
    const retryAt = later(now, 2 * MINUTE);
    const retried = await completeTask(testDb.db, taskLease(task, "w1"), {
      status: "pending",
      runAt: retryAt,
      error,
    });

    expect(retried).toMatchObject({
      status: "pending",
      runAt: retryAt,
      lastError: error,
      attempts: 1,
      finishedAt: null,
      lockedBy: null,
    });
    expect(
      (await claimDueTasks(testDb.db, { limit: 10, workerId: "w1", leaseMs: MINUTE, now })).claimed,
    ).toEqual([]);
    const [again] = (
      await claimDueTasks(testDb.db, { limit: 10, workerId: "w1", leaseMs: MINUTE, now: retryAt })
    ).claimed;
    expect(again).toMatchObject({ id: task.id, attempts: 2, lastError: error });
  });

  it("records failed and dead tasks with their error", async () => {
    for (const status of ["failed", "dead"] as const) {
      const { now, task } = await claimOne();
      const error = taskError(status === "dead" ? "exhausted" : "invalid_payload", now);
      const done = await completeTask(
        testDb.db,
        { ...taskLease(task, "w1"), now },
        { status, error },
      );
      expect(done).toMatchObject({ status, lastError: error, finishedAt: now, lockedBy: null });
    }
  });

  it("refuses a running task without a lease", async () => {
    expect(
      await pgError(
        testDb.db
          .insert(scheduledTasks)
          .values({ kind: "post.publish", status: "running", lockedBy: "w1" }),
      ),
    ).toEqual({ code: PG.checkViolation, constraint: "scheduled_tasks_lease_ck" });
  });
});

describe("retryTask", () => {
  it("puts a dead task back to pending with its attempts reset", async () => {
    const now = testClock();
    const { task } = await enqueueTask(testDb.db, {
      kind: "post.publish",
      payload: {},
      runAt: now,
      maxAttempts: 1,
    });
    const [claimed] = (
      await claimDueTasks(testDb.db, { limit: 10, workerId: "w1", leaseMs: MINUTE, now })
    ).claimed;
    const error = taskError("permanent", now);
    await completeTask(testDb.db, taskLease(claimed ?? task, "w1"), { status: "dead", error });

    const retried = await retryTask(testDb.db, { id: task.id, now: later(now, MINUTE) });
    expect(retried).toMatchObject({
      status: "pending",
      attempts: 0,
      runAt: later(now, MINUTE),
      finishedAt: null,
      lastError: error,
    });
    // Only failed and dead tasks can be retried.
    expect(await retryTask(testDb.db, { id: task.id })).toBeNull();
    expect(await retryTask(testDb.db, { id: randomUUID() })).toBeNull();
  });

  it("fails on the dedupe index when another task holds the key", async () => {
    const dedupeKey = `publish:${randomUUID()}`;
    const [dead] = await testDb.db
      .insert(scheduledTasks)
      .values({ kind: "post.publish", status: "dead", dedupeKey, attempts: 1, runAt: NEVER })
      .returning();
    await enqueueTask(testDb.db, {
      kind: "post.publish",
      payload: {},
      runAt: testClock(),
      maxAttempts: 5,
      dedupeKey,
    });

    expect(await pgError(retryTask(testDb.db, { id: dead?.id ?? "" }))).toEqual({
      code: PG.uniqueViolation,
      constraint: "scheduled_tasks_dedupe_key_uq",
    });
  });
});

describe("scheduled_tasks", () => {
  it("store kind as text, so a kind needs no migration", async () => {
    const result = await testDb.db.execute<{ data_type: string }>(
      sql`select data_type from information_schema.columns
          where table_name = 'scheduled_tasks' and column_name = 'kind'`,
    );
    expect(result.rows[0]?.data_type).toBe("text");
  });
});
