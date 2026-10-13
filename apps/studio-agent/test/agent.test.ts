import { readdirSync } from "node:fs";
import { createUlid, parseJobResult } from "@loomcast/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type RunningAgent, startAgent } from "../src/agent";
import { AGENT_VERSION, detectPlatform } from "../src/agent-info";
import { type Handler, HandlerRegistry } from "../src/handlers";
import { createHandlers } from "../src/jobs";
import { silentLogger } from "../src/logger";
import type { AgentPaths } from "../src/paths";
import { FakeBridge } from "./fake-bridge";
import { aborted, deferred, ids, tempAgentPaths, testConfig } from "./helpers";

const FAST = { backoff: { initialMs: 5, maxMs: 20, resetAfterMs: 60_000 } };

let bridge: FakeBridge;
const agents: RunningAgent[] = [];

beforeEach(async () => {
  bridge = await FakeBridge.start();
});

afterEach(async () => {
  await Promise.all(agents.splice(0).map((agent) => agent.stop()));
  await bridge.close();
});

function start(handlers: HandlerRegistry, paths: AgentPaths = tempAgentPaths()): RunningAgent {
  const agent = startAgent({
    config: testConfig({ serverUrl: bridge.serverUrl }),
    paths,
    handlers,
    log: silentLogger,
    timings: FAST,
  });
  agents.push(agent);
  return agent;
}

function registry(register: (registry: HandlerRegistry) => void): HandlerRegistry {
  const handlers = new HandlerRegistry();
  register(handlers);
  return handlers;
}

const pingResult = {
  agentVersion: AGENT_VERSION,
  runtime: { node: "v24.0.0", platform: "darwin-arm64" },
  producerAvailable: false,
};

describe("studio agent over the bridge", () => {
  it("says hello and runs an assigned system.ping", async () => {
    const paths = tempAgentPaths();
    const handlers = await createHandlers(
      {
        config: testConfig(),
        paths,
        log: silentLogger,
      },
      [],
    );
    start(handlers, paths);

    const hello = await bridge.waitFor("hello");
    expect(hello.payload).toEqual({
      protocol: 1,
      agentVersion: AGENT_VERSION,
      platform: detectPlatform(),
      jobTypes: ["system.ping"],
      credits: { producer: 1, render: 1 },
      resume: [],
    });

    bridge.autoAck = true;
    bridge.assign({ id: ids.job, type: "system.ping" });
    const complete = await bridge.waitFor("job.complete");
    expect(complete.payload.jobId).toBe(ids.job);
    expect(parseJobResult("system.ping", complete.payload.result).success).toBe(true);
    expect(bridge.received.map((message) => message.type)).toEqual([
      "hello",
      "job.accept",
      "credits",
      "job.event",
      "job.complete",
      "credits",
    ]);
    expect(bridge.messages("credits").map((message) => message.payload)).toEqual([
      { producer: 0, render: 1 },
      { producer: 1, render: 1 },
    ]);
  });

  it("replays unacked durable events after a forced disconnect", async () => {
    const step = deferred();
    const finish = deferred();
    const handlers = registry((r) =>
      r.register("system.ping", async (ctx) => {
        ctx.emit("status", { state: "one" });
        ctx.emit("status", { state: "two" });
        await step.promise;
        ctx.emit("status", { state: "three" });
        await finish.promise;
        return pingResult;
      }),
    );
    const agent = start(handlers);
    await bridge.waitFor("hello");
    bridge.assign({ id: ids.job, type: "system.ping" });
    await bridge.waitFor("job.event", (message) => message.payload.seq === 2);

    // The server stores event 1 only, then the network fails and stays down.
    bridge.ack(ids.job, 1);
    await expect.poll(() => agent.connection.ready).toBe(true);
    bridge.rejectUpgradesWith = 503;
    bridge.dropConnection();
    await expect.poll(() => agent.connection.ready).toBe(false);

    // An event recorded while offline is kept in the outbox.
    step.resolve();
    await expect.poll(() => agent.runner.resume()).toEqual([{ jobId: ids.job, lastAckedSeq: 1 }]);

    const before = bridge.received.length;
    bridge.rejectUpgradesWith = null;
    const hello = await bridge.waitFor("hello", () => true, before);
    expect(hello.payload.resume).toEqual([{ jobId: ids.job, lastAckedSeq: 1 }]);
    expect(hello.payload.credits).toEqual({ producer: 0, render: 1 });

    await bridge.waitFor("job.event", (message) => message.payload.seq === 3, before);
    const replayed = bridge.received
      .slice(before)
      .filter((message) => message.type === "job.event")
      .map((message) => message.payload);
    expect(replayed.map((event) => [event.seq, event.data])).toEqual([
      [2, { state: "two" }],
      [3, { state: "three" }],
    ]);

    finish.resolve();
    await bridge.waitFor("job.complete", () => true, before);
  });

  it("never resends acked events and settles the outbox", async () => {
    const paths = tempAgentPaths();
    const handlers = registry((r) =>
      r.register("system.ping", async (ctx) => {
        ctx.emit("status", { state: "running" });
        ctx.emit("log", { level: "info", message: "pong" });
        return pingResult;
      }),
    );
    const agent = start(handlers, paths);
    await bridge.waitFor("hello");
    bridge.autoAck = true;
    bridge.assign({ id: ids.job, type: "system.ping" });
    await bridge.waitFor("job.complete");
    await expect.poll(() => readdirSync(paths.outboxDir)).toEqual([]);

    const before = bridge.received.length;
    bridge.dropConnection();
    const hello = await bridge.waitFor("hello", () => true, before);
    expect(hello.payload.resume).toEqual([]);
    await expect.poll(() => agent.connection.ready).toBe(true);
    expect(bridge.received.slice(before).map((message) => message.type)).toEqual(["hello"]);
    expect(bridge.messages("job.event").map((message) => message.payload.seq)).toEqual([1, 2]);
  });

  it("rejects job types outside the allow-list without running anything", async () => {
    let runs = 0;
    const handlers = registry((r) =>
      r.register("system.ping", async () => {
        runs += 1;
        return pingResult;
      }),
    );
    start(handlers);
    await bridge.waitFor("hello");

    bridge.sendRaw(
      JSON.stringify({
        v: 1,
        id: createUlid(),
        ts: new Date().toISOString(),
        type: "job.assign",
        payload: {
          job: {
            id: ids.job,
            type: "shell.exec",
            attempt: 1,
            payload: { command: "rm -rf ~" },
            projectId: ids.project,
          },
          leaseMs: 600_000,
        },
      }),
    );
    const unknown = await bridge.waitFor("job.reject", (m) => m.payload.jobId === ids.job);
    expect(unknown.payload.reason).toBe("unsupported_job_type");

    // A type the contracts know but this agent has no handler for.
    bridge.assign({
      id: ids.otherJob,
      type: "producer.chat",
      payload: {
        conversationId: ids.device,
        projectId: ids.project,
        messageId: ids.job,
        text: "Hello",
      },
    });
    const unhandled = await bridge.waitFor("job.reject", (m) => m.payload.jobId === ids.otherJob);
    expect(unhandled.payload.reason).toBe("unsupported_job_type");

    expect(runs).toBe(0);
    expect(bridge.messages("job.accept")).toEqual([]);
    expect(bridge.connections).toBe(1);
  });

  it("aborts a running job on job.cancel", async () => {
    let sawAbort = false;
    const handlers = registry((r) =>
      r.register("system.ping", async (ctx) => {
        ctx.emit("status", { state: "waiting" });
        await aborted(ctx.signal);
        sawAbort = true;
        throw ctx.signal.reason;
      }),
    );
    const agent = start(handlers);
    await bridge.waitFor("hello");
    bridge.assign({ id: ids.job, type: "system.ping" });
    await bridge.waitFor("job.event");

    bridge.cancel(ids.job);
    const fail = await bridge.waitFor("job.fail");
    expect(fail.payload).toEqual({
      jobId: ids.job,
      error: { code: "cancelled", message: "The job was cancelled", retryable: false },
    });
    expect(sawAbort).toBe(true);
    expect(agent.runner.runningJobIds()).toEqual([]);
    await bridge.waitFor("credits", (m) => m.payload.producer === 1);
  });

  it("answers a re-assigned finished job from the journal, also after a restart", async () => {
    let runs = 0;
    const handler: Handler<"system.ping"> = async () => {
      runs += 1;
      return pingResult;
    };
    const paths = tempAgentPaths();
    const first = start(
      registry((r) => r.register("system.ping", handler)),
      paths,
    );
    await bridge.waitFor("hello");
    bridge.assign({ id: ids.job, type: "system.ping" });
    const original = await bridge.waitFor("job.complete");

    // The server did not see the result and assigns the job again.
    let before = bridge.received.length;
    bridge.assign({ id: ids.job, type: "system.ping" });
    const replay = await bridge.waitFor("job.complete", () => true, before);
    expect(replay.payload).toEqual(original.payload);
    expect(bridge.received.slice(before).map((message) => message.type)).toEqual([
      "job.accept",
      "job.complete",
    ]);

    // A new agent process on the same state directory still knows the outcome.
    await first.stop();
    agents.splice(agents.indexOf(first), 1);
    start(
      registry((r) => r.register("system.ping", handler)),
      paths,
    );
    before = bridge.received.length;
    await bridge.waitFor("hello", () => true, before);
    bridge.assign({ id: ids.job, type: "system.ping" });
    const afterRestart = await bridge.waitFor("job.complete", () => true, before);
    expect(afterRestart.payload).toEqual(original.payload);
    expect(runs).toBe(1);
  });

  it("runs a retried job again when its earlier attempt failed", async () => {
    let runs = 0;
    const handlers = registry((r) =>
      r.register("system.ping", async (ctx) => {
        runs += 1;
        ctx.emit("status", { state: `attempt ${ctx.job.attempt}` });
        if (ctx.job.attempt === 1) {
          throw new Error("first attempt fails");
        }
        return pingResult;
      }),
    );
    start(handlers);
    await bridge.waitFor("hello");
    bridge.assign({ id: ids.job, type: "system.ping" });
    await bridge.waitFor("job.fail");
    bridge.assign({ id: ids.job, type: "system.ping", attempt: 2 });
    await bridge.waitFor("job.complete");

    expect(runs).toBe(2);
    // The retry continues the event numbering instead of reusing seq 1.
    expect(bridge.messages("job.event").map((message) => message.payload.seq)).toEqual([1, 2]);
  });

  it("reports running jobs as interrupted when it stops", async () => {
    const handlers = registry((r) =>
      r.register("system.ping", async (ctx) => {
        await aborted(ctx.signal);
        throw new Error("stopped");
      }),
    );
    const agent = start(handlers);
    await bridge.waitFor("hello");
    bridge.assign({ id: ids.job, type: "system.ping" });
    await bridge.waitFor("job.accept");

    await expect(agent.stop()).resolves.toBe("stopped");
    const fail = await bridge.waitFor("job.fail");
    expect(fail.payload.error).toMatchObject({ code: "interrupted", retryable: true });
  });
});
