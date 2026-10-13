import { randomUUID } from "node:crypto";
import { jobs, projects } from "@loomcast/db";
import { createTestDb, type TestDb } from "@loomcast/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type BusEventOf, createEventBus } from "../src/lib/bus";
import { transaction } from "../src/lib/db";
import { createJobsService, toJobSummary } from "../src/modules/jobs/service";
import { insertUser } from "./support";

let testDb: TestDb;
let userId: string;
let projectId: string;

beforeAll(async () => {
  testDb = await createTestDb();
  const user = await insertUser(testDb.db);
  userId = user.id;
  const [project] = await testDb.db
    .insert(projects)
    .values({ slug: `jobs-${randomUUID()}`, name: "Jobs", createdBy: userId })
    .returning();
  projectId = project?.id ?? "";
});

afterAll(async () => {
  await testDb.drop();
});

function setup() {
  const bus = createEventBus();
  const events: BusEventOf<"job.enqueued">[] = [];
  bus.subscribe("job.enqueued", (event) => {
    events.push(event);
  });
  return { bus, events, service: createJobsService({ db: testDb.db, bus }) };
}

describe("jobs.enqueue", () => {
  it("inserts a queued job with the registry's attempts and publishes job.enqueued", async () => {
    const { service, events } = setup();
    const { job, created } = await service.enqueue(testDb.db, {
      type: "system.ping",
      payload: {},
      projectId,
      createdBy: userId,
    });
    expect(created).toBe(true);
    expect(job).toMatchObject({
      type: "system.ping",
      status: "queued",
      attempt: 0,
      maxAttempts: 3,
      conversationId: null,
      deviceAffinity: null,
      idempotencyKey: null,
    });
    expect(events).toEqual([
      {
        type: "job.enqueued",
        payload: { jobId: job.id, type: "system.ping", projectId, deviceAffinity: null },
      },
    ]);
    expect(toJobSummary(job)).toMatchObject({ id: job.id, status: "queued", finishedAt: null });
    expect(await service.get(job.id)).toEqual(job);
  });

  it("returns the existing job for a repeated idempotency key", async () => {
    const { service, events } = setup();
    const key = `key-${randomUUID()}`;
    const input = { type: "system.ping" as const, payload: {}, projectId, createdBy: userId };

    const first = await service.enqueue(testDb.db, { ...input, idempotencyKey: key });
    const second = await service.enqueue(testDb.db, { ...input, idempotencyKey: key });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.job.id).toBe(first.job.id);
    expect(events).toHaveLength(1);

    const rows = await testDb.db.select().from(jobs).where(eq(jobs.idempotencyKey, key));
    expect(rows).toHaveLength(1);

    // Keys are scoped per user, and jobs without a key never collide.
    const other = await insertUser(testDb.db);
    const theirs = await service.enqueue(testDb.db, {
      ...input,
      createdBy: other.id,
      idempotencyKey: key,
    });
    expect(theirs.created).toBe(true);
    const a = await service.enqueue(testDb.db, input);
    const b = await service.enqueue(testDb.db, input);
    expect(a.job.id).not.toBe(b.job.id);
  });

  it("deduplicates concurrent requests with the same key", async () => {
    const { service } = setup();
    const key = `race-${randomUUID()}`;
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        service.enqueue(testDb.db, {
          type: "system.ping",
          payload: {},
          projectId,
          createdBy: userId,
          idempotencyKey: key,
        }),
      ),
    );
    expect(new Set(results.map((result) => result.job.id)).size).toBe(1);
    expect(results.filter((result) => result.created)).toHaveLength(1);
  });

  it("validates the type and payload against the registry", async () => {
    const { service, events } = setup();
    await expect(
      service.enqueue(testDb.db, {
        type: "shell.exec" as "system.ping",
        payload: {},
        projectId,
        createdBy: userId,
      }),
    ).rejects.toMatchObject({ status: 400, code: "validation_failed" });

    await expect(
      service.enqueue(testDb.db, {
        type: "producer.chat",
        payload: { text: "hello" },
        projectId,
        createdBy: userId,
      }),
    ).rejects.toMatchObject({
      status: 400,
      details: expect.arrayContaining([
        expect.objectContaining({ path: "payload.conversationId" }),
      ]),
    });

    await expect(
      service.enqueue(testDb.db, {
        type: "system.ping",
        payload: {},
        projectId,
        createdBy: userId,
        idempotencyKey: "x".repeat(256),
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(events).toHaveLength(0);
  });

  it("publishes only after the transaction commits, and not at all on rollback", async () => {
    const { service, events } = setup();
    const { job } = await transaction(testDb.db, async (tx) => {
      const result = await service.enqueue(tx, {
        type: "system.ping",
        payload: {},
        projectId,
        createdBy: userId,
      });
      expect(events).toHaveLength(0);
      return result;
    });
    expect(events.map((event) => event.payload.jobId)).toEqual([job.id]);

    let rolledBackId: string | undefined;
    await expect(
      transaction(testDb.db, async (tx) => {
        const result = await service.enqueue(tx, {
          type: "system.ping",
          payload: {},
          projectId,
          createdBy: userId,
        });
        rolledBackId = result.job.id;
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");
    expect(events).toHaveLength(1);
    expect(await service.get(rolledBackId ?? "")).toBeNull();
  });

  it("returns null for unknown and malformed ids", async () => {
    const { service } = setup();
    expect(await service.get(randomUUID())).toBeNull();
    expect(await service.get("not-a-uuid")).toBeNull();
  });
});
