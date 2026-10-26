import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { conversations, jobEvents, jobs, messages } from "@loomcast/db";
import { createTestDb, type TestDb } from "@loomcast/db/testing";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
// The real studio agent, from its workspace source: these tests run its connection, runner,
// outbox and journal against the hub, so the two sides cannot drift apart unnoticed.
import { type RunningAgent, startAgent } from "../../studio-agent/src/agent";
import { HandlerRegistry } from "../../studio-agent/src/handlers";
import { createSystemPingHandler } from "../../studio-agent/src/jobs/system-ping";
import { silentLogger } from "../../studio-agent/src/logger";
import { type AgentPaths, resolveAgentPaths } from "../../studio-agent/src/paths";
import {
  type BridgeServer,
  createConversation,
  enqueue,
  type Fixtures,
  pairDevice,
  producerChatPayload,
  seedWorkspace,
  startBridgeServer,
  type TestDevice,
  trackUnhandledRejections,
} from "./bridge-support";

let testDb: TestDb;
let fixtures: Fixtures;
const rejections = trackUnhandledRejections();
const servers: BridgeServer[] = [];
const agents: RunningAgent[] = [];
const homes: string[] = [];

beforeAll(async () => {
  testDb = await createTestDb();
  fixtures = await seedWorkspace(testDb.db);
});

afterEach(async () => {
  await Promise.all(agents.splice(0).map((agent) => agent.stop()));
  for (const server of servers.splice(0)) {
    await server.close();
  }
  for (const home of homes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

afterAll(async () => {
  rejections.stop();
  expect(rejections.reasons).toEqual([]);
  await testDb.drop();
});

function agentPaths(): AgentPaths {
  const home = mkdtempSync(join(tmpdir(), "loomcast-hub-interop-"));
  homes.push(home);
  return resolveAgentPaths({ LOOMCAST_AGENT_HOME: join(home, "state") });
}

function runAgent(
  server: BridgeServer,
  device: TestDevice,
  handlers: HandlerRegistry,
  paths: AgentPaths = agentPaths(),
): RunningAgent {
  const agent = startAgent({
    config: {
      serverUrl: `http://127.0.0.1:${server.port}`,
      deviceId: device.deviceId,
      token: device.secret,
      workspaceRoot: join(paths.home, "workspace"),
      concurrency: { producer: 2, render: 1 },
    },
    paths,
    handlers,
    log: silentLogger,
    timings: { backoff: { initialMs: 5, maxMs: 20, resetAfterMs: 60_000 }, streamBatchMs: 5 },
  });
  agents.push(agent);
  return agent;
}

function waitForStatus(jobId: string, status: string) {
  return vi.waitFor(
    async () => {
      const [row] = await testDb.db.select().from(jobs).where(eq(jobs.id, jobId));
      expect(row?.status).toBe(status);
      return row;
    },
    { timeout: 10_000, interval: 20 },
  );
}

describe("the studio agent against the bridge hub", () => {
  it("runs system.ping and producer.chat end to end and settles its outbox", async () => {
    const server = await startBridgeServer(testDb.db);
    servers.push(server);
    const device = await pairDevice(testDb.db, fixtures.userId);
    const conversationId = await createConversation(testDb.db, fixtures);
    const sessionId = `interop-${randomUUID()}`;

    const handlers = new HandlerRegistry()
      .register("system.ping", createSystemPingHandler({ producerAvailable: () => true }))
      .register("producer.chat", async (ctx) => {
        ctx.emit("session", { sessionId });
        ctx.stream("Thinking about ");
        ctx.emit("assistant.message", { text: "First reply." });
        ctx.emit("tool.activity", { tool: "Read", summary: "notes.md" });
        ctx.emit("assistant.message", { text: "Second reply." });
        return {
          sdkSessionId: sessionId,
          finalText: "Second reply.",
          numTurns: 2,
          durationMs: 5,
        };
      });

    const ping = await enqueue(testDb.db, server.bus, {
      workspaceId: fixtures.workspaceId,
      createdBy: fixtures.userId,
    });
    const chat = await enqueue(testDb.db, server.bus, {
      type: "producer.chat",
      payload: producerChatPayload(fixtures, conversationId),
      workspaceId: fixtures.workspaceId,
      conversationId,
      createdBy: fixtures.userId,
    });

    const paths = agentPaths();
    runAgent(server, device, handlers, paths);

    const pinged = await waitForStatus(ping.id, "succeeded");
    expect(pinged?.result).toMatchObject({ producerAvailable: true });
    await waitForStatus(chat.id, "succeeded");
    expect(server.hub.connectedDevices().has(device.deviceId)).toBe(true);

    const replies = await testDb.db
      .select()
      .from(messages)
      .where(and(eq(messages.conversationId, conversationId), eq(messages.role, "assistant")))
      .orderBy(asc(messages.createdAt));
    expect(replies.map((row) => row.content.text)).toEqual(["First reply.", "Second reply."]);
    const [conversation] = await testDb.db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationId));
    expect(conversation).toMatchObject({
      producerSessionId: sessionId,
      deviceId: device.deviceId,
    });
    const events = await testDb.db
      .select()
      .from(jobEvents)
      .where(eq(jobEvents.jobId, chat.id))
      .orderBy(asc(jobEvents.seq));
    expect(events.map((row) => [row.seq, row.kind])).toEqual([
      [1, "session"],
      [2, "assistant.message"],
      [3, "tool.activity"],
      [4, "assistant.message"],
    ]);

    // Every durable event was acked and every outcome delivered: the outbox is empty.
    await vi.waitFor(() => expect(readdirSync(paths.outboxDir)).toEqual([]));
  });

  it("cancels a running job on the agent", async () => {
    const server = await startBridgeServer(testDb.db);
    servers.push(server);
    const device = await pairDevice(testDb.db, fixtures.userId);
    let markStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const handlers = new HandlerRegistry().register("system.ping", async (ctx) => {
      ctx.emit("status", { state: "waiting" });
      markStarted();
      await new Promise<void>((resolve) => {
        ctx.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      throw new Error("aborted");
    });
    const job = await enqueue(testDb.db, server.bus, {
      workspaceId: fixtures.workspaceId,
      createdBy: fixtures.userId,
    });
    runAgent(server, device, handlers);
    await started;
    await waitForStatus(job.id, "running");

    const cancelled = await server.hub.lifecycle.requestCancel(job.id);
    expect(cancelled?.changed).toBe(true);
    const row = await waitForStatus(job.id, "cancelled");
    expect(row?.error).toMatchObject({ code: "cancelled" });
  });

  it("stops the agent for good when its device is revoked", async () => {
    const server = await startBridgeServer(testDb.db);
    servers.push(server);
    const device = await pairDevice(testDb.db, fixtures.userId);
    const agent = runAgent(
      server,
      device,
      new HandlerRegistry().register(
        "system.ping",
        createSystemPingHandler({ producerAvailable: () => false }),
      ),
    );
    await vi.waitFor(() => expect(server.hub.connectedDevices().has(device.deviceId)).toBe(true));
    server.bus.publish({
      type: "device.revoked",
      payload: { deviceId: device.deviceId, tokenId: device.tokenId },
    });
    expect(await agent.done).toBe("revoked");
  });

  it("stops the older agent when a second one connects with the same device", async () => {
    const server = await startBridgeServer(testDb.db);
    servers.push(server);
    const device = await pairDevice(testDb.db, fixtures.userId);
    const registry = () =>
      new HandlerRegistry().register(
        "system.ping",
        createSystemPingHandler({ producerAvailable: () => false }),
      );
    const older = runAgent(server, device, registry());
    await vi.waitFor(() => expect(server.hub.connectedDevices().has(device.deviceId)).toBe(true));
    runAgent(server, device, registry());
    expect(await older.done).toBe("superseded");
    expect(server.hub.connectedDevices().has(device.deviceId)).toBe(true);
  });
});
