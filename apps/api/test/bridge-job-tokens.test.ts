import { randomUUID } from "node:crypto";
import {
  BRIDGE_TIMINGS,
  getJobDefinition,
  JOB_TOKEN_RE,
  MCP_PATH,
  type ServerMessageOf,
} from "@loomcast/contracts";
import { apiTokens, jobs, messages } from "@loomcast/db";
import { createTestDb, type TestDb } from "@loomcast/db/testing";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../src/lib/crypto";
import {
  type BridgeServer,
  createConversation,
  enqueue,
  FakeAgent,
  type Fixtures,
  pairDevice,
  producerChatPayload,
  seedProject,
  startBridgeServer,
  type TestDevice,
  trackUnhandledRejections,
} from "./bridge-support";
import { bearer, connectClient, rpc } from "./mcp-support";

let testDb: TestDb;
let fixtures: Fixtures;
const rejections = trackUnhandledRejections();
const servers: BridgeServer[] = [];
const agents: FakeAgent[] = [];

beforeAll(async () => {
  testDb = await createTestDb({ max: 10 });
  fixtures = await seedProject(testDb.db);
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
  await testDb.db.delete(messages);
  await testDb.db.delete(jobs);
});

afterAll(async () => {
  rejections.stop();
  expect(rejections.reasons).toEqual([]);
  await testDb.drop();
});

async function start(): Promise<BridgeServer> {
  const server = await startBridgeServer(testDb.db);
  servers.push(server);
  return server;
}

async function connect(server: BridgeServer, device: TestDevice): Promise<FakeAgent> {
  const agent = await FakeAgent.connect(server.port, { secret: device.secret });
  agents.push(agent);
  return agent;
}

async function jobTokens(jobId: string) {
  return testDb.db.select().from(apiTokens).where(eq(apiTokens.jobId, jobId));
}

function waitForStatus(jobId: string, status: string) {
  return vi.waitFor(
    async () => {
      const [row] = await testDb.db.select().from(jobs).where(eq(jobs.id, jobId));
      if (row?.status !== status) {
        throw new Error(`job ${jobId} is ${row?.status}`);
      }
      return row;
    },
    { timeout: 5_000, interval: 10 },
  );
}

/** Waits until every token of the job is revoked, and returns them. */
function waitForRevoked(jobId: string) {
  return vi.waitFor(
    async () => {
      const rows = await jobTokens(jobId);
      if (rows.length === 0 || rows.some((row) => row.revokedAt === null)) {
        throw new Error("job token not revoked yet");
      }
      return rows;
    },
    { timeout: 5_000, interval: 10 },
  );
}

async function producerChatJob(server: BridgeServer) {
  const conversationId = await createConversation(testDb.db, fixtures);
  return enqueue(testDb.db, server.bus, {
    type: "producer.chat",
    payload: producerChatPayload(fixtures, conversationId),
    projectId: fixtures.projectId,
    conversationId,
    createdBy: fixtures.userId,
  });
}

/** The job token sent with `assign`, checked against the contract. */
function tokenOf(assign: ServerMessageOf<"job.assign">): string {
  const credentials = assign.payload.credentials;
  if (credentials === undefined) {
    throw new Error("job.assign carried no credentials");
  }
  expect(credentials.mcp.endpoint).toBe(MCP_PATH);
  expect(credentials.mcp.token).toMatch(JOB_TOKEN_RE);
  return credentials.mcp.token;
}

async function verifies(server: BridgeServer, secret: string): Promise<boolean> {
  return (await server.moduleDeps.tokens.verify(secret, "job")) !== null;
}

describe("job credentials on assign", () => {
  it("mints a job token bound to the job and its project and sends it once", async () => {
    const server = await start();
    const device = await pairDevice(testDb.db, fixtures.userId);
    const job = await producerChatJob(server);
    const agent = await connect(server, device);
    await agent.hello();

    const assign = await agent.next("job.assign");
    const secret = tokenOf(assign);
    const definition = getJobDefinition("producer.chat");
    expect(assign.payload.credentials?.mcp.expiresAt).toBe(
      new Date(
        server.clock.now().getTime() + definition.timeoutMs + BRIDGE_TIMINGS.leaseMs,
      ).toISOString(),
    );

    const rows = await jobTokens(job.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "job",
      userId: fixtures.userId,
      projectId: fixtures.projectId,
      jobId: job.id,
      scopes: ["mcp:read", "mcp:write"],
      tokenHash: sha256Hex(secret),
      revokedAt: null,
    });
    const verified = await server.moduleDeps.tokens.verify(secret, "job");
    expect(verified).toMatchObject({
      kind: "job",
      projectId: fixtures.projectId,
      jobId: job.id,
      scopes: ["mcp:read", "mcp:write"],
    });

    agent.accept(job.id);
    await waitForStatus(job.id, "running");
    await agent.sync();
    // Only one assignment, and the secret never travels in any other frame.
    const frames = agent.received.filter((message) => JSON.stringify(message).includes(secret));
    expect(frames).toHaveLength(1);
    expect(frames[0]?.type).toBe("job.assign");

    // Never stored with the job, never logged.
    const [stored] = await testDb.db.select().from(jobs).where(eq(jobs.id, job.id));
    expect(JSON.stringify(stored)).not.toContain(secret);
    expect(server.logs.join("\n")).not.toContain(secret);
    expect(server.logs.join("\n")).not.toContain(secret.slice(-20));
  });

  it("sends no credentials and mints no token for a job without MCP access", async () => {
    const server = await start();
    const device = await pairDevice(testDb.db, fixtures.userId);
    const job = await enqueue(testDb.db, server.bus, {
      projectId: fixtures.projectId,
      createdBy: fixtures.userId,
    });
    const agent = await connect(server, device);
    await agent.hello();
    const assign = await agent.next("job.assign");
    expect(assign.payload.job.id).toBe(job.id);
    expect(assign.payload.credentials).toBeUndefined();
    expect(await jobTokens(job.id)).toEqual([]);
  });
});

describe("job token revocation", () => {
  it("revokes the token when the job succeeds", async () => {
    const server = await start();
    const device = await pairDevice(testDb.db, fixtures.userId);
    const job = await producerChatJob(server);
    const agent = await connect(server, device);
    await agent.hello();
    const secret = tokenOf(await agent.next("job.assign"));
    agent.accept(job.id);
    await waitForStatus(job.id, "running");
    expect(await verifies(server, secret)).toBe(true);
    // The producer session reaches the tool server with it while the job runs.
    const mcpUrl = new URL(MCP_PATH, `http://127.0.0.1:${server.port}`);
    const client = await connectClient(mcpUrl, secret);
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);
    await client.close();

    agent.send({
      type: "job.complete",
      payload: {
        jobId: job.id,
        result: { sdkSessionId: randomUUID(), finalText: "Done.", numTurns: 1, durationMs: 10 },
      },
    });
    await waitForStatus(job.id, "succeeded");
    await waitForRevoked(job.id);
    expect(await verifies(server, secret)).toBe(false);
    const refused = await rpc(
      mcpUrl,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test", version: "0.0.0" },
        },
      },
      bearer(secret),
    );
    expect(refused.status).toBe(401);
  });

  it("revokes the token when the job fails", async () => {
    const server = await start();
    const device = await pairDevice(testDb.db, fixtures.userId);
    const job = await producerChatJob(server);
    const agent = await connect(server, device);
    await agent.hello();
    const secret = tokenOf(await agent.next("job.assign"));
    agent.accept(job.id);
    await waitForStatus(job.id, "running");

    agent.send({
      type: "job.fail",
      payload: {
        jobId: job.id,
        error: { code: "producer_failed", message: "It broke", retryable: false },
      },
    });
    await waitForStatus(job.id, "failed");
    await waitForRevoked(job.id);
    expect(await verifies(server, secret)).toBe(false);
  });

  it("revokes the token when the job is cancelled", async () => {
    const server = await start();
    const device = await pairDevice(testDb.db, fixtures.userId);
    const job = await producerChatJob(server);
    const agent = await connect(server, device);
    await agent.hello();
    const secret = tokenOf(await agent.next("job.assign"));
    agent.accept(job.id);
    await waitForStatus(job.id, "running");

    await server.hub.lifecycle.requestCancel(job.id);
    // Asking for the cancel does not end the job yet; the token works until it ends.
    expect(await verifies(server, secret)).toBe(true);
    expect((await agent.next("job.cancel")).payload.jobId).toBe(job.id);
    agent.send({
      type: "job.fail",
      payload: {
        jobId: job.id,
        error: { code: "cancelled", message: "The job was cancelled", retryable: false },
      },
    });
    await waitForStatus(job.id, "cancelled");
    await waitForRevoked(job.id);
    expect(await verifies(server, secret)).toBe(false);
  });

  it("revokes the token when a lease expires and the job fails as interrupted", async () => {
    const server = await start();
    const device = await pairDevice(testDb.db, fixtures.userId);
    const job = await producerChatJob(server);
    const agent = await connect(server, device);
    await agent.hello();
    const secret = tokenOf(await agent.next("job.assign"));
    agent.accept(job.id);
    await waitForStatus(job.id, "running");
    await agent.close();

    server.clock.advance(BRIDGE_TIMINGS.leaseMs + 1);
    await server.hub.sweep();
    await waitForStatus(job.id, "failed");
    await waitForRevoked(job.id);
    expect(await verifies(server, secret)).toBe(false);
  });

  it("revokes the previous token on re-dispatch and sends a fresh one", async () => {
    const server = await start();
    const device = await pairDevice(testDb.db, fixtures.userId);
    const job = await producerChatJob(server);
    const agent = await connect(server, device);
    await agent.hello();
    const first = tokenOf(await agent.next("job.assign"));

    // A rejected assignment goes back to the queue and is dispatched again.
    agent.send({ type: "job.reject", payload: { jobId: job.id, reason: "busy" } });
    const second = tokenOf(await agent.next("job.assign", (m) => m.payload.job.id === job.id));
    expect(second).not.toBe(first);
    expect(await verifies(server, first)).toBe(false);
    expect(await verifies(server, second)).toBe(true);

    const rows = await jobTokens(job.id);
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.revokedAt === null)).toHaveLength(1);
    expect(
      await testDb.db
        .select()
        .from(apiTokens)
        .where(and(eq(apiTokens.jobId, job.id), eq(apiTokens.tokenHash, sha256Hex(second)))),
    ).toMatchObject([{ revokedAt: null }]);
  });

  it("revokes the token of an assignment that was never accepted", async () => {
    const server = await start();
    const device = await pairDevice(testDb.db, fixtures.userId);
    const job = await producerChatJob(server);
    const agent = await connect(server, device);
    await agent.hello({ credits: { producer: 1 } });
    const secret = tokenOf(await agent.next("job.assign"));
    await agent.close();

    server.clock.advance(BRIDGE_TIMINGS.acceptTimeoutMs + 1);
    await server.hub.sweep();
    await waitForStatus(job.id, "queued");
    await waitForRevoked(job.id);
    expect(await verifies(server, secret)).toBe(false);
  });
});
