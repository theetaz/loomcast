import { randomBytes, randomUUID } from "node:crypto";
import { BRIDGE_TIMINGS, CLOSE_CODES, createUlid, TOKEN_PREFIXES } from "@loomcast/contracts";
import { conversations, devices, jobEvents, jobs, messages } from "@loomcast/db";
import { createTestDb, type TestDb } from "@loomcast/db/testing";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { BusEventOf } from "../src/lib/bus";
import {
  type BridgeServer,
  createConversation,
  enqueue,
  FakeAgent,
  type Fixtures,
  pairDevice,
  producerChatPayload,
  seedWorkspace,
  startBridgeServer,
  type TestDevice,
  trackUnhandledRejections,
  UpgradeRefused,
} from "./bridge-support";
import { insertUser, login, send } from "./support";

let testDb: TestDb;
let fixtures: Fixtures;
const rejections = trackUnhandledRejections();
const servers: BridgeServer[] = [];
const agents: FakeAgent[] = [];

beforeAll(async () => {
  testDb = await createTestDb({ max: 10 });
  fixtures = await seedWorkspace(testDb.db);
});

afterEach(async () => {
  for (const agent of agents.splice(0)) {
    if (agent.ws.readyState === agent.ws.OPEN) {
      await agent.close();
    }
  }
  for (const server of servers.splice(0)) {
    await server.close();
  }
  // Each test starts from an empty queue.
  await testDb.db.delete(messages);
  await testDb.db.delete(jobs);
});

afterAll(async () => {
  rejections.stop();
  expect(rejections.reasons).toEqual([]);
  await testDb.drop();
});

async function start(options: Parameters<typeof startBridgeServer>[1] = {}) {
  const server = await startBridgeServer(testDb.db, options);
  servers.push(server);
  return server;
}

async function connect(server: BridgeServer, device: TestDevice): Promise<FakeAgent> {
  const agent = await FakeAgent.connect(server.port, { secret: device.secret });
  agents.push(agent);
  return agent;
}

async function jobRow(id: string) {
  const [row] = await testDb.db.select().from(jobs).where(eq(jobs.id, id));
  if (row === undefined) {
    throw new Error(`job ${id} not found`);
  }
  return row;
}

function waitForJob(id: string, predicate: (row: Awaited<ReturnType<typeof jobRow>>) => boolean) {
  return vi.waitFor(
    async () => {
      const row = await jobRow(id);
      if (!predicate(row)) {
        throw new Error(`job ${id} is ${row.status}`);
      }
      return row;
    },
    { timeout: 5_000, interval: 10 },
  );
}

function updates(server: BridgeServer, jobId: string): string[] {
  return server.events
    .filter((event): event is BusEventOf<"job.updated"> => event.type === "job.updated")
    .filter((event) => event.payload.job.id === jobId)
    .map((event) => event.payload.job.status);
}

/** A device token that is well formed but was never issued. */
function unknownDeviceSecret(): string {
  return `${TOKEN_PREFIXES.device}${randomBytes(32).toString("base64url").replace(/[-_]/g, "x")}`;
}

describe("bridge upgrade authentication", () => {
  it("opens a socket only for a valid, unrevoked device token without Origin", async () => {
    const server = await start();
    const device = await pairDevice(testDb.db, fixtures.userId);

    await expect(FakeAgent.connect(server.port)).rejects.toMatchObject({ status: 401 });
    await expect(
      FakeAgent.connect(server.port, { secret: unknownDeviceSecret() }),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      FakeAgent.connect(server.port, {
        secret: device.secret,
        headers: { origin: "https://evil.example.test" },
      }),
    ).rejects.toBeInstanceOf(UpgradeRefused);
    await expect(
      FakeAgent.connect(server.port, {
        secret: device.secret,
        headers: { origin: "https://evil.example.test" },
      }),
    ).rejects.toMatchObject({ status: 403 });

    const agent = await connect(server, device);
    await agent.hello();
    expect(server.hub.connectedDevices().has(device.deviceId)).toBe(true);

    const revoked = await pairDevice(testDb.db, fixtures.userId, "Revoked Mac");
    await testDb.db
      .update(devices)
      .set({ revokedAt: new Date() })
      .where(eq(devices.id, revoked.deviceId));
    await expect(FakeAgent.connect(server.port, { secret: revoked.secret })).rejects.toMatchObject({
      status: 403,
    });
  });

  it("records presence, last_seen_at and device.status on connect and disconnect", async () => {
    const server = await start();
    const device = await pairDevice(testDb.db, fixtures.userId);
    const agent = await connect(server, device);
    expect(server.moduleDeps.presence.connectedDevices().has(device.deviceId)).toBe(false);
    await agent.hello();
    expect(server.moduleDeps.presence.connectedDevices().has(device.deviceId)).toBe(true);

    const [row] = await testDb.db.select().from(devices).where(eq(devices.id, device.deviceId));
    expect(row?.lastSeenAt).not.toBeNull();
    expect(row?.agentVersion).toBe("0.1.0-test");

    await agent.close();
    const statuses = () =>
      server.events
        .filter((event): event is BusEventOf<"device.status"> => event.type === "device.status")
        .filter((event) => event.payload.deviceId === device.deviceId)
        .map((event) => event.payload.online);
    await vi.waitFor(() => expect(statuses()).toEqual([true, false]));
    expect(server.hub.connectedDevices().has(device.deviceId)).toBe(false);
  });
});

describe("bridge protocol handling", () => {
  it("closes with 4400 when the first message is not hello, and sends nothing before it", async () => {
    const server = await start();
    const device = await pairDevice(testDb.db, fixtures.userId);
    const agent = await connect(server, device);
    agent.send({ type: "credits", payload: { producer: 1, render: 1 } });
    expect((await agent.closed).code).toBe(CLOSE_CODES.malformedMessage);
    expect(agent.received).toEqual([]);
  });

  it("closes with 4400 for a malformed frame and 4426 for another protocol version", async () => {
    const server = await start();
    const device = await pairDevice(testDb.db, fixtures.userId);

    const garbled = await connect(server, device);
    garbled.sendRaw("{not json");
    expect((await garbled.closed).code).toBe(CLOSE_CODES.malformedMessage);

    const future = await connect(server, device);
    future.sendRaw(
      JSON.stringify({
        v: 1,
        id: createUlid(),
        type: "hello",
        ts: new Date().toISOString(),
        payload: {
          protocol: 2,
          agentVersion: "9.0.0",
          platform: "darwin-arm64",
          jobTypes: [],
          credits: { producer: 1, render: 1 },
          resume: [],
        },
      }),
    );
    expect((await future.closed).code).toBe(CLOSE_CODES.unsupportedProtocol);

    const newer = await connect(server, device);
    newer.sendRaw(JSON.stringify({ v: 2, id: "x", type: "hello", ts: "", payload: {} }));
    expect((await newer.closed).code).toBe(CLOSE_CODES.unsupportedProtocol);
  });

  it("supersedes an older connection of the same device with 4409", async () => {
    const server = await start();
    const device = await pairDevice(testDb.db, fixtures.userId);
    const first = await connect(server, device);
    await first.hello();
    const second = await connect(server, device);
    expect((await first.closed).code).toBe(CLOSE_CODES.superseded);
    await second.hello();
    expect(server.hub.connectedDevices().has(device.deviceId)).toBe(true);
  });

  it("closes a revoked device's socket with 4403", async () => {
    const server = await start();
    const device = await pairDevice(testDb.db, fixtures.userId);
    const agent = await connect(server, device);
    await agent.hello();
    server.bus.publish({
      type: "device.revoked",
      payload: { deviceId: device.deviceId, tokenId: device.tokenId },
    });
    expect((await agent.closed).code).toBe(CLOSE_CODES.revoked);
    await vi.waitFor(() => {
      expect(server.hub.connectedDevices().has(device.deviceId)).toBe(false);
    });
  });

  it("terminates a connection that misses two pongs", async () => {
    // Two missed pongs end a connection. The interval leaves room for a loaded machine to finish
    // the silent agent's hello and the healthy agent's pongs before that deadline.
    const server = await start({ pingIntervalMs: 250 });
    const device = await pairDevice(testDb.db, fixtures.userId);
    const healthy = await connect(server, device);
    const hello = await healthy.hello();
    expect(hello.payload.heartbeatMs).toBe(250);

    const other = await pairDevice(testDb.db, fixtures.userId, "Silent Mac");
    const silent = await FakeAgent.connect(server.port, { secret: other.secret, autoPong: false });
    agents.push(silent);
    await silent.hello();
    expect((await silent.closed).code).toBe(1006);
    expect(healthy.ws.readyState).toBe(healthy.ws.OPEN);
  });
});

describe("dispatch", () => {
  it("dispatches a job queued while the agent was offline when it says hello", async () => {
    const server = await start();
    const device = await pairDevice(testDb.db, fixtures.userId);
    const job = await enqueue(testDb.db, server.bus, {
      workspaceId: fixtures.workspaceId,
      createdBy: fixtures.userId,
    });

    const agent = await connect(server, device);
    const ok = await agent.hello();
    expect(ok.payload).toMatchObject({
      deviceId: device.deviceId,
      leaseMs: BRIDGE_TIMINGS.leaseMs,
      limits: { maxPayloadBytes: 1024 * 1024 },
    });
    const assign = await agent.next("job.assign");
    expect(assign.payload.job).toEqual({
      id: job.id,
      type: "system.ping",
      attempt: 1,
      payload: {},
      workspaceId: fixtures.workspaceId,
      // The legacy name, for agents older than the workspace rename.
      projectId: fixtures.workspaceId,
    });
    expect(assign.payload.leaseMs).toBe(BRIDGE_TIMINGS.leaseMs);
    expect(await jobRow(job.id)).toMatchObject({
      status: "dispatched",
      claimedByDevice: device.deviceId,
      attempt: 1,
    });

    agent.accept(job.id);
    const running = await waitForJob(job.id, (row) => row.status === "running");
    expect(running.leaseExpiresAt?.getTime()).toBe(
      server.clock.now().getTime() + BRIDGE_TIMINGS.leaseMs,
    );
    // job.updated is published after the commit, so it can trail the row the test just read.
    await vi.waitFor(() => expect(updates(server, job.id)).toEqual(["dispatched", "running"]));
  });

  it("dispatches a job enqueued while the agent is connected", async () => {
    const server = await start();
    const device = await pairDevice(testDb.db, fixtures.userId);
    const agent = await connect(server, device);
    await agent.hello();
    const job = await enqueue(testDb.db, server.bus, {
      workspaceId: fixtures.workspaceId,
      createdBy: fixtures.userId,
    });
    expect((await agent.next("job.assign")).payload.job.id).toBe(job.id);
  });

  it("respects credits per concurrency class", async () => {
    const server = await start();
    const device = await pairDevice(testDb.db, fixtures.userId);
    const queued = [];
    for (let i = 0; i < 3; i += 1) {
      queued.push(
        await enqueue(testDb.db, server.bus, {
          workspaceId: fixtures.workspaceId,
          createdBy: fixtures.userId,
        }),
      );
    }
    const agent = await connect(server, device);
    await agent.hello({ credits: { producer: 2, render: 4 } });
    const first = await agent.next("job.assign");
    const second = await agent.next("job.assign");
    expect([first.payload.job.id, second.payload.job.id]).toEqual([queued[0]?.id, queued[1]?.id]);

    // More triggers do not exceed the two unanswered assignments.
    await server.hub.dispatcher.run();
    expect(agent.all("job.assign")).toHaveLength(2);

    agent.accept(first.payload.job.id);
    agent.accept(second.payload.job.id);
    agent.send({ type: "credits", payload: { producer: 0, render: 4 } });
    await waitForJob(second.payload.job.id, (row) => row.status === "running");
    await server.hub.dispatcher.run();
    expect(agent.all("job.assign")).toHaveLength(2);

    agent.send({
      type: "job.complete",
      payload: {
        jobId: first.payload.job.id,
        result: {
          agentVersion: "0.1.0-test",
          runtime: { node: "v24.0.0", platform: "darwin-arm64" },
          producerAvailable: true,
        },
      },
    });
    agent.send({ type: "credits", payload: { producer: 1, render: 4 } });
    const third = await agent.next("job.assign");
    expect(third.payload.job.id).toBe(queued[2]?.id);
    expect((await jobRow(first.payload.job.id)).status).toBe("succeeded");
  });

  it("honours device affinity", async () => {
    const server = await start();
    const mine = await pairDevice(testDb.db, fixtures.userId, "Affinity Mac");
    const other = await pairDevice(testDb.db, fixtures.userId, "Other Mac");
    const pinned = await enqueue(testDb.db, server.bus, {
      workspaceId: fixtures.workspaceId,
      createdBy: fixtures.userId,
      deviceAffinity: mine.deviceId,
    });

    const otherAgent = await connect(server, other);
    await otherAgent.hello();
    await server.hub.dispatcher.run();
    expect(otherAgent.all("job.assign")).toEqual([]);
    expect((await jobRow(pinned.id)).status).toBe("queued");

    const mineAgent = await connect(server, mine);
    await mineAgent.hello();
    expect((await mineAgent.next("job.assign")).payload.job.id).toBe(pinned.id);
  });

  it("lets any agent take a job pinned to a revoked device", async () => {
    const server = await start();
    const gone = await pairDevice(testDb.db, fixtures.userId, "Gone Mac");
    await testDb.db
      .update(devices)
      .set({ revokedAt: new Date() })
      .where(eq(devices.id, gone.deviceId));
    const other = await pairDevice(testDb.db, fixtures.userId, "Other Mac");
    const job = await enqueue(testDb.db, server.bus, {
      workspaceId: fixtures.workspaceId,
      createdBy: fixtures.userId,
      deviceAffinity: gone.deviceId,
    });
    const agent = await connect(server, other);
    await agent.hello();
    expect((await agent.next("job.assign")).payload.job.id).toBe(job.id);
  });

  it("only assigns the job types the agent advertised", async () => {
    const server = await start();
    const device = await pairDevice(testDb.db, fixtures.userId);
    const conversationId = await createConversation(testDb.db, fixtures);
    const chat = await enqueue(testDb.db, server.bus, {
      type: "producer.chat",
      payload: producerChatPayload(fixtures, conversationId),
      workspaceId: fixtures.workspaceId,
      conversationId,
      createdBy: fixtures.userId,
    });
    const agent = await connect(server, device);
    await agent.hello({ jobTypes: ["system.ping"] });
    await server.hub.dispatcher.run();
    expect(agent.all("job.assign")).toEqual([]);
    expect((await jobRow(chat.id)).status).toBe("queued");
  });

  it("re-queues a rejected job without counting the attempt", async () => {
    const server = await start();
    const device = await pairDevice(testDb.db, fixtures.userId);
    const job = await enqueue(testDb.db, server.bus, {
      workspaceId: fixtures.workspaceId,
      createdBy: fixtures.userId,
    });
    const agent = await connect(server, device);
    await agent.hello();
    await agent.next("job.assign");
    agent.send({ type: "job.reject", payload: { jobId: job.id, reason: "no_credits" } });
    await waitForJob(job.id, (row) => row.status === "queued");
    expect(await jobRow(job.id)).toMatchObject({ attempt: 0, claimedByDevice: null });
    // No credits until the agent reports some again.
    await server.hub.dispatcher.run();
    expect(agent.all("job.assign")).toHaveLength(1);
    agent.send({ type: "credits", payload: { producer: 1, render: 1 } });
    expect((await agent.next("job.assign")).payload.job.attempt).toBe(1);
  });

  it("fails a job the agent rejects as invalid", async () => {
    const server = await start();
    const device = await pairDevice(testDb.db, fixtures.userId);
    const job = await enqueue(testDb.db, server.bus, {
      workspaceId: fixtures.workspaceId,
      createdBy: fixtures.userId,
    });
    const agent = await connect(server, device);
    await agent.hello();
    await agent.next("job.assign");
    agent.send({ type: "job.reject", payload: { jobId: job.id, reason: "invalid_payload: x" } });
    const failed = await waitForJob(job.id, (row) => row.status === "failed");
    expect(failed.error).toMatchObject({ code: "invalid_payload", retryable: false });
  });

  it("re-queues a job not accepted within the accept timeout and stops a late accept", async () => {
    const server = await start();
    const device = await pairDevice(testDb.db, fixtures.userId);
    const job = await enqueue(testDb.db, server.bus, {
      workspaceId: fixtures.workspaceId,
      createdBy: fixtures.userId,
    });
    const agent = await connect(server, device);
    await agent.hello({ credits: { producer: 1 } });
    await agent.next("job.assign");

    server.clock.advance(BRIDGE_TIMINGS.acceptTimeoutMs - 1);
    await server.hub.sweep();
    expect((await jobRow(job.id)).status).toBe("dispatched");

    // With no free slot, the sweep's dispatch round cannot hand the job straight back.
    agent.send({ type: "credits", payload: { producer: 0, render: 0 } });
    await agent.sync();
    server.clock.advance(2);
    const swept = await server.hub.sweep();
    expect(swept.map((entry) => entry.job.id)).toEqual([job.id]);
    expect(await jobRow(job.id)).toMatchObject({ status: "queued", claimedByDevice: null });

    agent.accept(job.id);
    expect((await agent.next("job.cancel")).payload.jobId).toBe(job.id);
    expect((await jobRow(job.id)).status).toBe("queued");
  });

  it("re-queues dispatched jobs the agent does not list after a reconnect", async () => {
    const server = await start();
    const device = await pairDevice(testDb.db, fixtures.userId);
    const job = await enqueue(testDb.db, server.bus, {
      workspaceId: fixtures.workspaceId,
      createdBy: fixtures.userId,
    });
    const first = await connect(server, device);
    await first.hello();
    await first.next("job.assign");
    await first.close();

    const second = await connect(server, device);
    await second.hello();
    const assign = await second.next("job.assign");
    expect(assign.payload.job).toMatchObject({ id: job.id, attempt: 2 });
  });
});

describe("durable events", () => {
  it("stores each event once and acks cumulatively, never before hello.ok", async () => {
    const server = await start();
    const device = await pairDevice(testDb.db, fixtures.userId);
    const job = await enqueue(testDb.db, server.bus, {
      workspaceId: fixtures.workspaceId,
      createdBy: fixtures.userId,
    });
    const agent = await connect(server, device);
    await agent.hello();
    await agent.next("job.assign");
    agent.accept(job.id);

    const event = (seq: number) =>
      agent.send({
        type: "job.event",
        payload: {
          jobId: job.id,
          seq,
          kind: "log",
          data: { level: "info", message: `step ${seq}` },
        },
      });
    event(1);
    event(2);
    event(3);
    event(2);
    event(1);
    await vi.waitFor(() => expect(agent.all("ack")).toHaveLength(5));
    expect(agent.all("ack").map((ack) => ack.payload.upToSeq)).toEqual([1, 2, 3, 3, 3]);
    expect(agent.received.findIndex((message) => message.type === "ack")).toBeGreaterThan(
      agent.received.findIndex((message) => message.type === "hello.ok"),
    );
    const rows = await testDb.db
      .select()
      .from(jobEvents)
      .where(eq(jobEvents.jobId, job.id))
      .orderBy(asc(jobEvents.seq));
    expect(rows.map((row) => [row.seq, row.data])).toEqual([
      [1, { level: "info", message: "step 1" }],
      [2, { level: "info", message: "step 2" }],
      [3, { level: "info", message: "step 3" }],
    ]);
  });

  it("acks but does not store events of another device's job, or kinds the type may not emit", async () => {
    const server = await start();
    const device = await pairDevice(testDb.db, fixtures.userId);
    const job = await enqueue(testDb.db, server.bus, {
      workspaceId: fixtures.workspaceId,
      createdBy: fixtures.userId,
    });
    const agent = await connect(server, device);
    await agent.hello({ credits: { producer: 0 } });
    agent.send({
      type: "job.event",
      payload: { jobId: job.id, seq: 1, kind: "status", data: { state: "running" } },
    });
    expect((await agent.next("ack")).payload).toEqual({ jobId: job.id, upToSeq: 1 });

    agent.send({ type: "credits", payload: { producer: 1, render: 1 } });
    await agent.next("job.assign");
    agent.accept(job.id);
    agent.send({
      type: "job.event",
      payload: { jobId: job.id, seq: 2, kind: "assistant.message", data: { text: "nope" } },
    });
    expect((await agent.next("error")).payload.code).toBe("invalid_event");
    expect((await agent.next("ack")).payload.upToSeq).toBe(2);
    const rows = await testDb.db.select().from(jobEvents).where(eq(jobEvents.jobId, job.id));
    expect(rows).toEqual([]);
  });
});

describe("resume and leases", () => {
  it("lets an agent resume a running job after a reconnect within the grace period", async () => {
    const server = await start();
    const device = await pairDevice(testDb.db, fixtures.userId);
    const job = await enqueue(testDb.db, server.bus, {
      workspaceId: fixtures.workspaceId,
      createdBy: fixtures.userId,
    });
    const first = await connect(server, device);
    await first.hello();
    await first.next("job.assign");
    first.accept(job.id);
    first.send({
      type: "job.event",
      payload: { jobId: job.id, seq: 1, kind: "status", data: { state: "running" } },
    });
    await first.next("ack");
    await first.close();

    server.clock.advance(BRIDGE_TIMINGS.leaseMs - 60_000);
    await server.hub.sweep();
    expect((await jobRow(job.id)).status).toBe("running");

    const second = await connect(server, device);
    await second.hello({ credits: { producer: 0 }, resume: [{ jobId: job.id, lastAckedSeq: 1 }] });
    const resumed = await jobRow(job.id);
    expect(resumed.status).toBe("running");
    expect(resumed.leaseExpiresAt?.getTime()).toBe(
      server.clock.now().getTime() + BRIDGE_TIMINGS.leaseMs,
    );

    second.send({
      type: "job.event",
      payload: { jobId: job.id, seq: 2, kind: "log", data: { level: "info", message: "resumed" } },
    });
    expect((await second.next("ack")).payload.upToSeq).toBe(2);
    second.send({ type: "job.heartbeat", payload: { jobIds: [job.id] } });
    second.send({
      type: "job.complete",
      payload: {
        jobId: job.id,
        result: {
          agentVersion: "0.1.0-test",
          runtime: { node: "v24.0.0", platform: "darwin-arm64" },
          producerAvailable: false,
        },
      },
    });
    await waitForJob(job.id, (row) => row.status === "succeeded");
    expect(second.all("job.cancel")).toEqual([]);
    expect(
      await testDb.db.select().from(jobEvents).where(eq(jobEvents.jobId, job.id)),
    ).toHaveLength(2);
  });

  it("fails an expired producer.chat job as interrupted and stops it on reconnect", async () => {
    const server = await start();
    const device = await pairDevice(testDb.db, fixtures.userId);
    const conversationId = await createConversation(testDb.db, fixtures);
    const job = await enqueue(testDb.db, server.bus, {
      type: "producer.chat",
      payload: producerChatPayload(fixtures, conversationId),
      workspaceId: fixtures.workspaceId,
      conversationId,
      createdBy: fixtures.userId,
    });
    const first = await connect(server, device);
    await first.hello();
    await first.next("job.assign");
    first.accept(job.id);
    await waitForJob(job.id, (row) => row.status === "running");
    await first.close();

    server.clock.advance(BRIDGE_TIMINGS.leaseMs + 1);
    const swept = await server.hub.sweep();
    expect(swept.map((entry) => entry.job.id)).toEqual([job.id]);
    const failed = await jobRow(job.id);
    expect(failed).toMatchObject({
      status: "failed",
      error: { code: "interrupted", retryable: true },
    });
    expect(failed.finishedAt).not.toBeNull();
    // job.updated is published after the commit, so it can trail the row the test just read.
    await vi.waitFor(() =>
      expect(updates(server, job.id)).toEqual(["dispatched", "running", "failed"]),
    );

    const second = await connect(server, device);
    await second.hello({ resume: [{ jobId: job.id, lastAckedSeq: 0 }] });
    expect((await second.next("job.cancel")).payload.jobId).toBe(job.id);
    second.send({
      type: "job.fail",
      payload: {
        jobId: job.id,
        error: { code: "cancelled", message: "The job was cancelled", retryable: false },
      },
    });
    await second.sync();
    expect(await jobRow(job.id)).toMatchObject({
      status: "failed",
      error: { code: "interrupted" },
    });
  });

  it("re-queues an expired idempotent job until its attempts run out", async () => {
    const server = await start();
    const device = await pairDevice(testDb.db, fixtures.userId);
    const job = await enqueue(testDb.db, server.bus, {
      workspaceId: fixtures.workspaceId,
      createdBy: fixtures.userId,
    });
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const agent = await connect(server, device);
      await agent.hello();
      const assign = await agent.next("job.assign");
      expect(assign.payload.job.attempt).toBe(attempt);
      agent.accept(job.id);
      agent.send({
        type: "job.event",
        payload: { jobId: job.id, seq: 1, kind: "status", data: { state: "running" } },
      });
      await agent.next("ack");
      await agent.close();
      server.clock.advance(BRIDGE_TIMINGS.leaseMs + 1);
      await server.hub.sweep();
      const row = await jobRow(job.id);
      if (attempt < 3) {
        expect(row).toMatchObject({ status: "queued", attempt, claimedByDevice: null });
        // Events of the abandoned attempt are cleared so the next one can start at seq 1.
        expect(await testDb.db.select().from(jobEvents).where(eq(jobEvents.jobId, job.id))).toEqual(
          [],
        );
      } else {
        expect(row).toMatchObject({ status: "failed", error: { code: "interrupted" } });
      }
    }
  });
});

describe("outcomes", () => {
  it("treats a repeated job.complete or job.fail as a no-op", async () => {
    const server = await start();
    const device = await pairDevice(testDb.db, fixtures.userId);
    const job = await enqueue(testDb.db, server.bus, {
      workspaceId: fixtures.workspaceId,
      createdBy: fixtures.userId,
    });
    const agent = await connect(server, device);
    await agent.hello();
    await agent.next("job.assign");
    agent.accept(job.id);
    const result = {
      agentVersion: "0.1.0-test",
      runtime: { node: "v24.0.0", platform: "darwin-arm64" },
      producerAvailable: false,
    };
    agent.send({ type: "job.complete", payload: { jobId: job.id, result } });
    agent.send({ type: "job.complete", payload: { jobId: job.id, result } });
    agent.send({
      type: "job.fail",
      payload: { jobId: job.id, error: { code: "internal", message: "late", retryable: false } },
    });
    await agent.sync();
    expect(await jobRow(job.id)).toMatchObject({ status: "succeeded", result, error: null });
    // job.updated is published after the commit, so it can trail the row the test just read.
    await vi.waitFor(() =>
      expect(updates(server, job.id)).toEqual(["dispatched", "running", "succeeded"]),
    );
  });

  it("fails a job whose result does not match the registry", async () => {
    const server = await start();
    const device = await pairDevice(testDb.db, fixtures.userId);
    const job = await enqueue(testDb.db, server.bus, {
      workspaceId: fixtures.workspaceId,
      createdBy: fixtures.userId,
    });
    const agent = await connect(server, device);
    await agent.hello();
    await agent.next("job.assign");
    agent.accept(job.id);
    agent.send({ type: "job.complete", payload: { jobId: job.id, result: { nope: true } } });
    const failed = await waitForJob(job.id, (row) => row.status === "failed");
    expect(failed.error).toMatchObject({ code: "invalid_result", retryable: false });
  });

  it("ignores outcomes for jobs another device holds", async () => {
    const server = await start();
    const holder = await pairDevice(testDb.db, fixtures.userId, "Holder");
    const intruder = await pairDevice(testDb.db, fixtures.userId, "Intruder");
    const job = await enqueue(testDb.db, server.bus, {
      workspaceId: fixtures.workspaceId,
      createdBy: fixtures.userId,
    });
    const agent = await connect(server, holder);
    await agent.hello();
    await agent.next("job.assign");
    agent.accept(job.id);
    await waitForJob(job.id, (row) => row.status === "running");

    const other = await connect(server, intruder);
    await other.hello({ credits: { producer: 0 } });
    other.send({
      type: "job.fail",
      payload: { jobId: job.id, error: { code: "internal", message: "x", retryable: false } },
    });
    other.accept(job.id);
    expect((await other.next("job.cancel")).payload.jobId).toBe(job.id);
    expect((await jobRow(job.id)).status).toBe("running");
  });
});

describe("producer.chat", () => {
  it("stores each assistant reply once, relays deltas and keeps the session on success", async () => {
    const server = await start();
    const sessionId = `session-${randomUUID()}`;
    const device = await pairDevice(testDb.db, fixtures.userId);
    const conversationId = await createConversation(testDb.db, fixtures);
    const job = await enqueue(testDb.db, server.bus, {
      type: "producer.chat",
      payload: producerChatPayload(fixtures, conversationId),
      workspaceId: fixtures.workspaceId,
      conversationId,
      createdBy: fixtures.userId,
    });
    const agent = await connect(server, device);
    await agent.hello();
    const assign = await agent.next("job.assign");
    expect(assign.payload.job.conversationId).toBe(conversationId);
    agent.accept(job.id);

    agent.send({
      type: "job.event",
      payload: { jobId: job.id, seq: 1, kind: "session", data: { sessionId } },
    });
    agent.send({
      type: "job.stream",
      payload: { jobId: job.id, kind: "assistant.delta", text: "Here is" },
    });
    agent.send({
      type: "job.event",
      payload: {
        jobId: job.id,
        seq: 2,
        kind: "assistant.message",
        data: { text: "Here is a plan." },
      },
    });
    agent.send({
      type: "job.event",
      payload: {
        jobId: job.id,
        seq: 3,
        kind: "tool.activity",
        data: { tool: "WebSearch", summary: "bridges history" },
      },
    });
    agent.send({
      type: "job.event",
      payload: { jobId: job.id, seq: 4, kind: "assistant.message", data: { text: "Final hook." } },
    });
    // A replay after a reconnect must not add a third reply.
    agent.send({
      type: "job.event",
      payload: { jobId: job.id, seq: 4, kind: "assistant.message", data: { text: "Final hook." } },
    });
    agent.send({
      type: "job.complete",
      payload: {
        jobId: job.id,
        result: {
          sdkSessionId: sessionId,
          finalText: "Final hook.",
          numTurns: 2,
          durationMs: 1200,
        },
      },
    });
    await waitForJob(job.id, (row) => row.status === "succeeded");

    const replies = await testDb.db
      .select()
      .from(messages)
      .where(and(eq(messages.conversationId, conversationId), eq(messages.role, "assistant")))
      .orderBy(asc(messages.createdAt));
    expect(replies.map((row) => [row.content.text, row.jobId])).toEqual([
      ["Here is a plan.", job.id],
      ["Final hook.", job.id],
    ]);
    const [conversation] = await testDb.db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationId));
    expect(conversation).toMatchObject({
      producerSessionId: sessionId,
      deviceId: device.deviceId,
    });
    expect(conversation?.lastMessageAt).not.toBeNull();

    const types = server.events.map((event) => event.type);
    expect(types.filter((type) => type === "conversation.message.created")).toHaveLength(2);
    expect(server.events).toContainEqual({
      type: "conversation.message.delta",
      payload: { conversationId, jobId: job.id, text: "Here is" },
    });
    expect(server.events).toContainEqual({
      type: "job.activity",
      payload: { jobId: job.id, kind: "WebSearch", summary: "bridges history" },
    });
  });

  it("keeps the conversation's session unchanged when the turn fails", async () => {
    const server = await start();
    const device = await pairDevice(testDb.db, fixtures.userId);
    const conversationId = await createConversation(testDb.db, fixtures);
    const job = await enqueue(testDb.db, server.bus, {
      type: "producer.chat",
      payload: producerChatPayload(fixtures, conversationId),
      workspaceId: fixtures.workspaceId,
      conversationId,
      createdBy: fixtures.userId,
    });
    const agent = await connect(server, device);
    await agent.hello();
    await agent.next("job.assign");
    agent.accept(job.id);
    agent.send({
      type: "job.fail",
      payload: {
        jobId: job.id,
        error: {
          code: "producer_not_authenticated",
          message: "The producer runtime is not signed in",
          retryable: false,
        },
      },
    });
    const failed = await waitForJob(job.id, (row) => row.status === "failed");
    expect(failed.error?.code).toBe("producer_not_authenticated");
    const [conversation] = await testDb.db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationId));
    expect(conversation).toMatchObject({ producerSessionId: null, deviceId: null });
  });
});

describe("conversation turns through the messages route", () => {
  it("answers a posted message and pins the next turn to the same device and session", async () => {
    const server = await start();
    const user = await insertUser(testDb.db);
    const { cookie } = await login(server.app, user.email);
    const device = await pairDevice(testDb.db, fixtures.userId);
    const conversationId = await createConversation(testDb.db, fixtures);
    const sessionId = `session-${randomUUID()}`;
    const agent = await connect(server, device);
    await agent.hello();

    const posted = await send(server.app, "POST", `/api/conversations/${conversationId}/messages`, {
      cookie,
      body: { text: "Pitch me a short about bridges", clientMessageId: randomUUID() },
    });
    expect(posted.status).toBe(201);
    const first = (await posted.json()) as { job: { id: string } };
    const assign = await agent.next("job.assign");
    expect(assign.payload.job.id).toBe(first.job.id);
    expect(assign.payload.job.payload).not.toHaveProperty("producerSessionId");
    agent.accept(first.job.id);
    agent.send({
      type: "job.event",
      payload: { jobId: first.job.id, seq: 1, kind: "assistant.message", data: { text: "Sure." } },
    });
    agent.send({
      type: "job.complete",
      payload: {
        jobId: first.job.id,
        result: { sdkSessionId: sessionId, finalText: "Sure.", numTurns: 1, durationMs: 10 },
      },
    });
    agent.send({ type: "credits", payload: { producer: 1, render: 1 } });
    await waitForJob(first.job.id, (row) => row.status === "succeeded");

    const listed = await send(server.app, "GET", `/api/conversations/${conversationId}/messages`, {
      cookie,
    });
    const page = (await listed.json()) as { items: { role: string; content: { text: string } }[] };
    expect(page.items.map((item) => [item.role, item.content.text])).toEqual(
      expect.arrayContaining([
        ["user", "Pitch me a short about bridges"],
        ["assistant", "Sure."],
      ]),
    );

    const again = await send(server.app, "POST", `/api/conversations/${conversationId}/messages`, {
      cookie,
      body: { text: "Make it shorter", clientMessageId: randomUUID() },
    });
    const second = (await again.json()) as { job: { id: string } };
    expect(await jobRow(second.job.id)).toMatchObject({ deviceAffinity: device.deviceId });
    const next = await agent.next("job.assign");
    expect(next.payload.job).toMatchObject({
      id: second.job.id,
      payload: { producerSessionId: sessionId },
    });
  });
});

describe("cancel", () => {
  async function signIn(server: BridgeServer) {
    const user = await insertUser(testDb.db);
    const { cookie } = await login(server.app, user.email);
    return cookie;
  }

  it("cancels a queued job at once and returns 404 for unknown jobs", async () => {
    const server = await start();
    const cookie = await signIn(server);
    const job = await enqueue(testDb.db, server.bus, {
      workspaceId: fixtures.workspaceId,
      createdBy: fixtures.userId,
    });

    const got = await send(server.app, "GET", `/api/jobs/${job.id}`, { cookie });
    expect(got.status).toBe(200);
    expect(await got.json()).toMatchObject({ id: job.id, status: "queued" });

    const response = await send(server.app, "POST", `/api/jobs/${job.id}/cancel`, { cookie });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "cancelled",
      error: { code: "cancelled" },
    });

    const again = await send(server.app, "POST", `/api/jobs/${job.id}/cancel`, { cookie });
    expect(await again.json()).toMatchObject({ status: "cancelled" });

    const missing = await send(
      server.app,
      "POST",
      "/api/jobs/00000000-0000-4000-8000-000000000000/cancel",
      { cookie },
    );
    expect(missing.status).toBe(404);
    expect((await send(server.app, "GET", "/api/jobs/not-a-uuid", { cookie })).status).toBe(404);
    expect((await send(server.app, "GET", `/api/jobs/${job.id}`)).status).toBe(401);
  });

  it("sends job.cancel for a running job and records the agent's cancellation", async () => {
    const server = await start();
    const cookie = await signIn(server);
    const device = await pairDevice(testDb.db, fixtures.userId);
    const job = await enqueue(testDb.db, server.bus, {
      workspaceId: fixtures.workspaceId,
      createdBy: fixtures.userId,
    });
    const agent = await connect(server, device);
    await agent.hello();
    await agent.next("job.assign");
    agent.accept(job.id);
    await waitForJob(job.id, (row) => row.status === "running");

    const response = await send(server.app, "POST", `/api/jobs/${job.id}/cancel`, { cookie });
    expect(await response.json()).toMatchObject({ status: "running" });
    expect((await jobRow(job.id)).cancelRequestedAt).not.toBeNull();
    expect((await agent.next("job.cancel")).payload.jobId).toBe(job.id);

    agent.send({
      type: "job.fail",
      payload: {
        jobId: job.id,
        error: { code: "cancelled", message: "The job was cancelled", retryable: false },
      },
    });
    const cancelled = await waitForJob(job.id, (row) => row.status === "cancelled");
    expect(cancelled.finishedAt).not.toBeNull();
  });

  it("stops a cancelled job when its agent reconnects, and cancels it if the lease expires", async () => {
    const server = await start();
    const cookie = await signIn(server);
    const device = await pairDevice(testDb.db, fixtures.userId);
    const job = await enqueue(testDb.db, server.bus, {
      workspaceId: fixtures.workspaceId,
      createdBy: fixtures.userId,
    });
    const first = await connect(server, device);
    await first.hello();
    await first.next("job.assign");
    first.accept(job.id);
    await waitForJob(job.id, (row) => row.status === "running");
    await first.close();

    await send(server.app, "POST", `/api/jobs/${job.id}/cancel`, { cookie });
    const second = await connect(server, device);
    await second.hello({ resume: [{ jobId: job.id, lastAckedSeq: 0 }] });
    expect((await second.next("job.cancel")).payload.jobId).toBe(job.id);
    await second.close();

    server.clock.advance(BRIDGE_TIMINGS.leaseMs + 1);
    await server.hub.sweep();
    expect(await jobRow(job.id)).toMatchObject({ status: "cancelled" });
  });
});
