import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "../src/client";
import { jobs } from "../src/schema";
import { createTestDb, type TestDb } from "../src/testing";
import { insertJob, insertUser, insertWorkspace, jobValues, PG, pgError } from "./fixtures";

let testDb: TestDb;

beforeAll(async () => {
  testDb = await createTestDb();
});

afterAll(async () => {
  await testDb.drop();
});

describe("jobs idempotency key", () => {
  it("is unique per creator, ignores rows without a key, and supports insert-or-skip", async () => {
    const alice = await insertUser(testDb.db);
    const bob = await insertUser(testDb.db);
    const workspace = await insertWorkspace(testDb.db, alice.id);
    const base = { workspaceId: workspace.id, idempotencyKey: "retry-1" };

    await insertJob(testDb.db, { ...base, createdBy: alice.id });
    const error = await pgError(insertJob(testDb.db, { ...base, createdBy: alice.id }));
    expect(error).toEqual({
      code: PG.uniqueViolation,
      constraint: "jobs_created_by_idempotency_key_uq",
    });

    // The same key from another user is a different request.
    await insertJob(testDb.db, { ...base, createdBy: bob.id });

    // Jobs without a key never conflict.
    await insertJob(testDb.db, { workspaceId: workspace.id, createdBy: alice.id });
    await insertJob(testDb.db, { workspaceId: workspace.id, createdBy: alice.id });

    // The pattern the API uses: insert, or find the job the first request created.
    const skipped = await testDb.db
      .insert(jobs)
      .values(jobValues({ ...base, createdBy: alice.id }))
      .onConflictDoNothing({
        target: [jobs.createdBy, jobs.idempotencyKey],
        where: sql`${jobs.idempotencyKey} is not null`,
      })
      .returning({ id: jobs.id });
    expect(skipped).toEqual([]);
  });
});

/**
 * Claims the oldest queued job of a workspace without waiting on rows another transaction has
 * locked. Scoped to one workspace so jobs from other tests in this file are ignored.
 */
function claimNextQueued(tx: Pick<Database, "select">, workspaceId: string) {
  return tx
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.status, "queued"), eq(jobs.workspaceId, workspaceId)))
    .orderBy(asc(jobs.createdAt))
    .limit(1)
    .for("update", { skipLocked: true });
}

describe("claiming queued jobs", () => {
  it("lets two concurrent transactions claim different jobs with SKIP LOCKED", async () => {
    const user = await insertUser(testDb.db);
    const workspace = await insertWorkspace(testDb.db, user.id);
    const first = await insertJob(testDb.db, { workspaceId: workspace.id, createdBy: user.id });
    const second = await insertJob(testDb.db, {
      workspaceId: workspace.id,
      createdBy: user.id,
      createdAt: new Date(first.createdAt.getTime() + 1_000),
    });

    let releaseFirst = (): void => {};
    const firstMayCommit = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstClaimed = (_id: string | undefined): void => {};
    const firstClaim = new Promise<string | undefined>((resolve) => {
      firstClaimed = resolve;
    });

    // Transaction A claims a job and keeps its row lock until B has claimed too.
    const transactionA = testDb.db.transaction(async (tx) => {
      const [claimed] = await claimNextQueued(tx, workspace.id);
      firstClaimed(claimed?.id);
      await firstMayCommit;
      if (claimed !== undefined) {
        await tx.update(jobs).set({ status: "dispatched" }).where(eq(jobs.id, claimed.id));
      }
      return claimed?.id;
    });

    const claimedByA = await firstClaim;
    const claimedByB = await testDb.db.transaction(async (tx) => {
      const [claimed] = await claimNextQueued(tx, workspace.id);
      if (claimed !== undefined) {
        await tx.update(jobs).set({ status: "dispatched" }).where(eq(jobs.id, claimed.id));
      }
      return claimed?.id;
    });
    releaseFirst();
    await transactionA;

    expect(claimedByA).toBe(first.id);
    expect(claimedByB).toBe(second.id);
    const rows = await testDb.db
      .select({ status: jobs.status })
      .from(jobs)
      .where(and(inArray(jobs.id, [first.id, second.id]), eq(jobs.status, "dispatched")));
    expect(rows).toHaveLength(2);
  });

  it("keeps a partial index on queued jobs for the claim query", async () => {
    const result = await testDb.db.execute<{ indexdef: string }>(
      sql`select indexdef from pg_indexes where indexname = 'jobs_queued_created_at_idx'`,
    );
    expect(result.rows[0]?.indexdef).toMatch(
      /\(created_at\) WHERE \(status = 'queued'::job_status\)/,
    );
  });
});
