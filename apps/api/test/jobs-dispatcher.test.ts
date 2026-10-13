import { createDb, type DbHandle, jobs } from "@loomcast/db";
import { createTestDb, type TestDb } from "@loomcast/db/testing";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEventBus } from "../src/lib/bus";
import { systemClock } from "../src/lib/clock";
import { createLogger } from "../src/lib/logger";
import {
  createDispatcher,
  type Dispatcher,
  type DispatchSession,
} from "../src/modules/jobs/dispatcher";
import { createJobLifecycle } from "../src/modules/jobs/lifecycle";
import { enqueue, type Fixtures, pairDevice, seedProject } from "./bridge-support";

let testDb: TestDb;
let fixtures: Fixtures;
const handles: DbHandle[] = [];

beforeAll(async () => {
  testDb = await createTestDb();
  fixtures = await seedProject(testDb.db);
});

afterAll(async () => {
  await Promise.all(handles.map((handle) => handle.close()));
  await testDb.drop();
});

/** A dispatcher with its own connection pool, as a second api process would have. */
function dispatcherOnOwnPool(sessions: () => DispatchSession[] = () => []): Dispatcher {
  const handle = createDb(testDb.url, { max: 4 });
  handles.push(handle);
  const bus = createEventBus();
  const logger = createLogger({ level: "silent" });
  const lifecycle = createJobLifecycle({ db: handle.db, bus, clock: systemClock });
  return createDispatcher({ db: handle.db, bus, clock: systemClock, logger, lifecycle, sessions });
}

describe("dispatcher", () => {
  it("never assigns a job twice across two dispatchers on the same database", async () => {
    const devices = await Promise.all(
      ["A", "B", "C", "D"].map((name) => pairDevice(testDb.db, fixtures.userId, `Mac ${name}`)),
    );
    const first = dispatcherOnOwnPool();
    const second = dispatcherOnOwnPool();
    const bus = createEventBus();

    for (let iteration = 0; iteration < 100; iteration += 1) {
      const queued = await Promise.all(
        Array.from({ length: 10 }, () =>
          enqueue(testDb.db, bus, { projectId: fixtures.projectId, createdBy: fixtures.userId }),
        ),
      );
      const claims = await Promise.all(
        devices.map((device, index) =>
          (index % 2 === 0 ? first : second).claim({
            deviceId: device.deviceId,
            jobTypes: ["system.ping", "producer.chat"],
            credits: { producer: 3, render: 3 },
          }),
        ),
      );
      const claimedIds = claims.flat().map((row) => row.id);
      expect(new Set(claimedIds).size).toBe(claimedIds.length);
      expect(claimedIds.length).toBeLessThanOrEqual(queued.length);
      for (const [index, rows] of claims.entries()) {
        expect(rows.length).toBeLessThanOrEqual(3);
        for (const row of rows) {
          expect(row).toMatchObject({
            status: "dispatched",
            claimedByDevice: devices[index]?.deviceId,
            attempt: 1,
          });
        }
      }
      const stored = await testDb.db
        .select()
        .from(jobs)
        .where(
          inArray(
            jobs.id,
            queued.map((job) => job.id),
          ),
        );
      const dispatched = stored.filter((row) => row.status === "dispatched");
      expect(dispatched.map((row) => row.id).sort()).toEqual([...claimedIds].sort());
      await testDb.db.delete(jobs);
    }
  });

  it("claims oldest first and skips excluded and cancel-requested jobs", async () => {
    const device = await pairDevice(testDb.db, fixtures.userId);
    const dispatcher = dispatcherOnOwnPool();
    const bus = createEventBus();
    const a = await enqueue(testDb.db, bus, {
      projectId: fixtures.projectId,
      createdBy: fixtures.userId,
    });
    const b = await enqueue(testDb.db, bus, {
      projectId: fixtures.projectId,
      createdBy: fixtures.userId,
    });
    const c = await enqueue(testDb.db, bus, {
      projectId: fixtures.projectId,
      createdBy: fixtures.userId,
    });
    await testDb.db.update(jobs).set({ cancelRequestedAt: new Date() }).where(eq(jobs.id, b.id));

    const claimed = await dispatcher.claim({
      deviceId: device.deviceId,
      jobTypes: ["system.ping"],
      credits: { producer: 5, render: 0 },
      exclude: [a.id],
    });
    expect(claimed.map((row) => row.id)).toEqual([c.id]);
    expect(
      await dispatcher.claim({
        deviceId: device.deviceId,
        jobTypes: ["system.ping"],
        credits: { producer: 0, render: 5 },
      }),
    ).toEqual([]);
    await testDb.db.delete(jobs);
  });

  it("ignores job types the database does not know yet instead of failing the claim", async () => {
    const device = await pairDevice(testDb.db, fixtures.userId);
    const dispatcher = dispatcherOnOwnPool();
    const job = await enqueue(testDb.db, createEventBus(), {
      projectId: fixtures.projectId,
      createdBy: fixtures.userId,
    });
    const claimed = await dispatcher.claim({
      deviceId: device.deviceId,
      // Known to the contracts; the job_type enum may not have it until its migration lands.
      jobTypes: ["system.ping", "kb.analyze_reference"],
      credits: { producer: 2, render: 0 },
    });
    expect(claimed.map((row) => row.id)).toEqual([job.id]);
    await testDb.db.delete(jobs);
  });

  it("puts a job back in the queue when its assignment cannot be delivered", async () => {
    const device = await pairDevice(testDb.db, fixtures.userId);
    const session: DispatchSession = {
      deviceId: device.deviceId,
      target: () => ({
        deviceId: device.deviceId,
        jobTypes: ["system.ping"],
        credits: { producer: 1, render: 0 },
      }),
      assign: () => false,
    };
    const dispatcher = dispatcherOnOwnPool(() => [session]);
    const job = await enqueue(testDb.db, createEventBus(), {
      projectId: fixtures.projectId,
      createdBy: fixtures.userId,
    });
    await dispatcher.run();
    const [row] = await testDb.db.select().from(jobs).where(eq(jobs.id, job.id));
    expect(row).toMatchObject({ status: "queued", claimedByDevice: null });
    await testDb.db.delete(jobs);
  });
});
