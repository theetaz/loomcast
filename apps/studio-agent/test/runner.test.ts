import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { inspect } from "node:util";
import {
  type AgentToServerDraft,
  type AssignedJob,
  BRIDGE_LIMITS,
  createUlid,
  type JobType,
  parseServerMessage,
  type ServerMessageOf,
} from "@loomcast/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  type Handler,
  type HandlerCredentials,
  HandlerRegistry,
  JobFailure,
  REDACTED_JOB_TOKEN,
} from "../src/handlers";
import { Journal } from "../src/journal";
import { createLogger, silentLogger } from "../src/logger";
import { Outbox } from "../src/outbox";
import { type BridgeTransport, chunkText, JobRunner, type RunnerOptions } from "../src/runner";
import { aborted, deferred, ids, tempAgentPaths, testJobToken } from "./helpers";

class FakeTransport implements BridgeTransport {
  ready = true;
  bufferedAmount = 0;
  readonly sent: AgentToServerDraft[] = [];

  send(draft: AgentToServerDraft): boolean {
    if (!this.ready) {
      return false;
    }
    this.sent.push(draft);
    return true;
  }

  of<T extends AgentToServerDraft["type"]>(type: T): Extract<AgentToServerDraft, { type: T }>[] {
    return this.sent.filter(
      (draft): draft is Extract<AgentToServerDraft, { type: T }> => draft.type === type,
    );
  }

  types(): string[] {
    return this.sent.map((draft) => draft.type);
  }
}

const chatPayload = {
  conversationId: ids.otherJob,
  workspaceId: ids.workspace,
  messageId: ids.device,
  text: "Write three hooks",
};

const chatResult = { sdkSessionId: "session-1", finalText: "Done.", numTurns: 1, durationMs: 5 };

const runners: JobRunner[] = [];

afterEach(async () => {
  await Promise.all(runners.splice(0).map((runner) => runner.shutdown()));
});

function setup(
  register: (registry: HandlerRegistry) => void,
  overrides: Partial<RunnerOptions> = {},
  paths = tempAgentPaths(),
) {
  const registry = new HandlerRegistry();
  register(registry);
  const transport = new FakeTransport();
  const outbox = Outbox.open(paths.outboxDir, silentLogger);
  const journal = Journal.open(paths.journalFile, { log: silentLogger });
  const runner = new JobRunner({
    handlers: registry,
    outbox,
    journal,
    transport,
    concurrency: { producer: 1, render: 1 },
    log: silentLogger,
    streamBatchMs: 5,
    ...overrides,
  });
  runners.push(runner);
  return { runner, transport, outbox, journal, paths };
}

function assign(
  runner: JobRunner,
  job: Partial<AssignedJob> & { type: JobType },
  credentials?: ServerMessageOf<"job.assign">["payload"]["credentials"],
): ServerMessageOf<"job.assign"> {
  const message: ServerMessageOf<"job.assign"> = {
    v: 1,
    id: createUlid(),
    ts: new Date().toISOString(),
    type: "job.assign",
    payload: {
      job: { id: ids.job, attempt: 1, payload: {}, workspaceId: ids.workspace, ...job },
      leaseMs: 600_000,
      ...(credentials === undefined ? {} : { credentials }),
    },
  };
  runner.handle(message);
  return message;
}

function outcomeOf(transport: FakeTransport) {
  return transport.sent.find((draft) => draft.type === "job.complete" || draft.type === "job.fail");
}

async function settled(transport: FakeTransport) {
  await expect.poll(() => outcomeOf(transport)).toBeDefined();
  return outcomeOf(transport);
}

const pingHandler: Handler<"system.ping"> = async (ctx) => {
  ctx.emit("status", { state: "running" });
  return {
    agentVersion: "0.1.0",
    runtime: { node: "v24", platform: "darwin-arm64" },
    producerAvailable: false,
  };
};

describe("job runner", () => {
  it("accepts, runs and completes a job, updating credits", async () => {
    const { runner, transport } = setup((registry) =>
      registry.register("system.ping", pingHandler),
    );
    const message = assign(runner, { type: "system.ping" });

    expect(transport.sent[0]).toEqual({
      type: "job.accept",
      ref: message.id,
      payload: { jobId: ids.job },
    });
    expect(transport.sent[1]).toEqual({ type: "credits", payload: { producer: 0, render: 1 } });
    await settled(transport);
    expect(transport.types()).toEqual([
      "job.accept",
      "credits",
      "job.event",
      "job.complete",
      "credits",
    ]);
    expect(transport.of("job.event")[0]?.payload).toEqual({
      jobId: ids.job,
      seq: 1,
      kind: "status",
      data: { state: "running" },
    });
    expect(runner.credits()).toEqual({ producer: 1, render: 1 });
  });

  it("rejects job types without a handler", () => {
    const { runner, transport } = setup((registry) =>
      registry.register("system.ping", pingHandler),
    );
    assign(runner, { type: "producer.chat", payload: chatPayload });
    expect(transport.sent).toEqual([
      expect.objectContaining({
        type: "job.reject",
        payload: { jobId: ids.job, reason: "unsupported_job_type" },
      }),
    ]);
  });

  it("rejects an assignment for a type unknown to the contracts", () => {
    const { runner, transport } = setup((registry) =>
      registry.register("system.ping", pingHandler),
    );
    const frame = JSON.stringify({
      v: 1,
      id: createUlid(),
      ts: new Date().toISOString(),
      type: "job.assign",
      payload: {
        job: {
          id: ids.job,
          type: "shell.exec",
          attempt: 1,
          payload: {},
          workspaceId: ids.workspace,
        },
        leaseMs: 1000,
      },
    });
    const parsed = parseServerMessage(frame);
    if (parsed.ok) {
      throw new Error("expected the frame to fail validation");
    }
    runner.invalidFrame(frame, parsed);
    expect(transport.of("job.reject")[0]?.payload).toEqual({
      jobId: ids.job,
      reason: "unsupported_job_type",
    });
  });

  it("rejects a payload that fails the registry schema", () => {
    let ran = false;
    const { runner, transport } = setup((registry) =>
      registry.register("producer.chat", async () => {
        ran = true;
        return chatResult;
      }),
    );
    assign(runner, { type: "producer.chat", payload: { ...chatPayload, text: "   " } });
    expect(transport.of("job.reject")[0]?.payload.reason).toMatch(/^invalid_payload: text/);
    expect(ran).toBe(false);
  });

  it("rejects jobs beyond the free credits of their class", async () => {
    const gate = deferred();
    const { runner, transport } = setup((registry) =>
      registry.register("producer.chat", async () => {
        await gate.promise;
        return chatResult;
      }),
    );
    assign(runner, { type: "producer.chat", payload: chatPayload });
    assign(runner, { id: ids.otherJob, type: "producer.chat", payload: chatPayload });
    expect(transport.of("job.reject")[0]?.payload).toEqual({
      jobId: ids.otherJob,
      reason: "no_credits",
    });
    gate.resolve();
    await settled(transport);
  });

  it("answers a duplicate assignment of a running job with another accept", async () => {
    const gate = deferred();
    let runs = 0;
    const { runner, transport } = setup((registry) =>
      registry.register("system.ping", async (ctx) => {
        runs += 1;
        await gate.promise;
        return pingHandler(ctx);
      }),
    );
    assign(runner, { type: "system.ping" });
    assign(runner, { type: "system.ping" });
    expect(transport.of("job.accept")).toHaveLength(2);
    gate.resolve();
    await settled(transport);
    expect(runs).toBe(1);
  });

  it("aborts a job on cancel and fails it as cancelled", async () => {
    let sawAbort = false;
    const { runner, transport } = setup((registry) =>
      registry.register("system.ping", async (ctx) => {
        await aborted(ctx.signal);
        sawAbort = true;
        throw new Error("aborted");
      }),
    );
    assign(runner, { type: "system.ping" });
    runner.handle({
      v: 1,
      id: createUlid(),
      ts: new Date().toISOString(),
      type: "job.cancel",
      payload: { jobId: ids.job },
    });
    expect(await settled(transport)).toEqual({
      type: "job.fail",
      payload: {
        jobId: ids.job,
        error: { code: "cancelled", message: "The job was cancelled", retryable: false },
      },
    });
    expect(sawAbort).toBe(true);
    expect(runner.credits().producer).toBe(1);
  });

  it("fails a job that runs past its timeout, even if it ignores the signal", async () => {
    const { runner, transport } = setup(
      (registry) => registry.register("system.ping", () => new Promise(() => {})),
      { timeoutMs: () => 20 },
    );
    assign(runner, { type: "system.ping" });
    const outcome = await settled(transport);
    expect(outcome?.type === "job.fail" && outcome.payload.error.code).toBe("timeout");
    expect(runner.runningJobIds()).toEqual([]);
  });

  it("maps handler errors to job errors", async () => {
    const { runner, transport } = setup((registry) =>
      registry.register("producer.chat", async () => {
        throw new JobFailure("producer_not_authenticated", "Log in first");
      }),
    );
    assign(runner, { type: "producer.chat", payload: chatPayload });
    expect(await settled(transport)).toMatchObject({
      type: "job.fail",
      payload: { error: { code: "producer_not_authenticated", retryable: false } },
    });
  });

  it("fails a job whose result does not match the registry", async () => {
    const { runner, transport } = setup((registry) =>
      registry.register("producer.chat", async () => ({ ...chatResult, numTurns: -1 })),
    );
    assign(runner, { type: "producer.chat", payload: chatPayload });
    expect(await settled(transport)).toMatchObject({
      payload: { error: { code: "invalid_result" } },
    });
  });

  it("refuses durable event kinds the registry does not allow", async () => {
    const { runner, transport } = setup((registry) =>
      registry.register("system.ping", async (ctx) => {
        ctx.emit("session", { sessionId: "s" });
        return pingHandler(ctx);
      }),
    );
    assign(runner, { type: "system.ping" });
    expect(await settled(transport)).toMatchObject({
      payload: { error: { code: "internal", message: expect.stringContaining("session") } },
    });
    expect(transport.of("job.event")).toEqual([]);
  });

  it("batches stream deltas", async () => {
    const gate = deferred();
    const { runner, transport } = setup((registry) =>
      registry.register("producer.chat", async (ctx) => {
        ctx.stream("Hello, ");
        ctx.stream("world");
        await gate.promise;
        return chatResult;
      }),
    );
    assign(runner, { type: "producer.chat", payload: chatPayload });
    await expect.poll(() => transport.of("job.stream").length).toBe(1);
    expect(transport.of("job.stream")[0]?.payload).toEqual({
      jobId: ids.job,
      kind: "assistant.delta",
      text: "Hello, world",
    });
    gate.resolve();
    await settled(transport);
  });

  it("drops stream deltas when the socket buffer is over 512 KiB", async () => {
    const { runner, transport } = setup((registry) =>
      registry.register("producer.chat", async (ctx) => {
        ctx.stream("dropped");
        ctx.emit("assistant.message", { text: "dropped" });
        return chatResult;
      }),
    );
    transport.bufferedAmount = BRIDGE_LIMITS.backpressureBytes + 1;
    assign(runner, { type: "producer.chat", payload: chatPayload });
    await settled(transport);
    expect(transport.of("job.stream")).toEqual([]);
    // Durable events are never dropped.
    expect(transport.of("job.event")).toHaveLength(1);
  });

  it("sends heartbeats while jobs run", async () => {
    const gate = deferred();
    const { runner, transport } = setup(
      (registry) =>
        registry.register("system.ping", async (ctx) => {
          await gate.promise;
          return pingHandler(ctx);
        }),
      { heartbeatMs: 10 },
    );
    assign(runner, { type: "system.ping" });
    await expect.poll(() => transport.of("job.heartbeat").length).toBeGreaterThanOrEqual(2);
    expect(transport.of("job.heartbeat")[0]?.payload).toEqual({ jobIds: [ids.job] });
    gate.resolve();
    await settled(transport);
  });

  it("keeps the outbox until events are acked and settles it afterwards", async () => {
    const { runner, transport, outbox } = setup((registry) =>
      registry.register("system.ping", pingHandler),
    );
    assign(runner, { type: "system.ping" });
    await settled(transport);
    expect(outbox.has(ids.job)).toBe(true);
    runner.handle({
      v: 1,
      id: createUlid(),
      ts: new Date().toISOString(),
      type: "ack",
      payload: { jobId: ids.job, upToSeq: 1 },
    });
    expect(outbox.has(ids.job)).toBe(false);
  });

  it("fails jobs interrupted by a restart and reports them on connect", () => {
    const paths = tempAgentPaths();
    const before = Outbox.open(paths.outboxDir, silentLogger);
    before.open(ids.job, { type: "producer.chat", attempt: 1 });
    before.append(ids.job, "status", { state: "running" });

    const { runner, transport } = setup(() => {}, {}, paths);
    runner.recoverInterrupted();
    expect(runner.resume()).toEqual([{ jobId: ids.job, lastAckedSeq: 0 }]);
    runner.connected();
    expect(transport.types()).toEqual(["job.event", "job.fail"]);
    expect(transport.of("job.fail")[0]?.payload.error).toMatchObject({
      code: "interrupted",
      retryable: true,
    });
  });

  it("aborts running jobs as interrupted on shutdown", async () => {
    const { runner, transport } = setup((registry) =>
      registry.register("system.ping", async (ctx) => {
        await aborted(ctx.signal);
        throw new Error("aborted");
      }),
    );
    assign(runner, { type: "system.ping" });
    await runner.shutdown();
    expect(outcomeOf(transport)).toMatchObject({
      type: "job.fail",
      payload: { error: { code: "interrupted", retryable: true } },
    });
  });
});

describe("job credentials", () => {
  const SERVER_URL = "https://loomcast.example.com";

  function jobCredentials(token: string, endpoint = "/mcp") {
    return { mcp: { endpoint, token, expiresAt: new Date(Date.now() + 600_000).toISOString() } };
  }

  /** A chat handler that records its credentials and tries to leak them everywhere it can. */
  function leakyChat(seen: HandlerCredentials[]): Handler<"producer.chat"> {
    return async (ctx) => {
      seen.push(ctx.credentials);
      ctx.log.info("credentials received", { credentials: ctx.credentials });
      ctx.log.info(`inspected ${inspect(ctx.credentials)}`);
      ctx.emit("status", { state: "running", message: JSON.stringify(ctx.credentials) });
      return chatResult;
    };
  }

  it("resolves the endpoint against the server URL and hands them to the handler", async () => {
    const token = testJobToken();
    const seen: HandlerCredentials[] = [];
    const { runner, transport } = setup(
      (registry) => registry.register("producer.chat", leakyChat(seen)),
      { serverUrl: SERVER_URL },
    );
    assign(runner, { type: "producer.chat", payload: chatPayload }, jobCredentials(token));
    expect(await settled(transport)).toMatchObject({ type: "job.complete" });

    const mcp = seen[0]?.mcp;
    expect(mcp?.url.toString()).toBe("https://loomcast.example.com/mcp");
    expect(mcp?.token).toBe(token);
    expect(JSON.stringify(seen[0])).not.toContain(token);
    expect(JSON.stringify(seen[0])).toContain(REDACTED_JOB_TOKEN);
    expect(inspect(seen[0], { depth: 5 })).not.toContain(token);
  });

  it("never writes the token to the logs, the outbox, the journal or the socket", async () => {
    const token = testJobToken();
    const lines: string[] = [];
    const paths = tempAgentPaths();
    const outboxText: string[] = [];
    const seen: HandlerCredentials[] = [];
    const leaky = leakyChat(seen);
    const { runner, transport } = setup(
      (registry) =>
        registry.register("producer.chat", async (ctx) => {
          const result = await leaky(ctx);
          // The outbox file of the running job, before it is settled.
          for (const name of readdirSync(paths.outboxDir)) {
            outboxText.push(readFileSync(join(paths.outboxDir, name), "utf8"));
          }
          return result;
        }),
      {
        serverUrl: SERVER_URL,
        log: createLogger({ level: "debug", write: (line) => lines.push(line) }),
      },
      paths,
    );
    const message = assign(
      runner,
      { type: "producer.chat", payload: chatPayload },
      jobCredentials(token),
    );
    await settled(transport);

    expect(seen[0]?.mcp?.token).toBe(token);
    expect(outboxText.join("")).toContain("running");
    expect(outboxText.join("")).not.toContain(token);
    expect(readFileSync(paths.journalFile, "utf8")).not.toContain(token);
    expect(lines.join("")).toContain("credentials received");
    expect(lines.join("")).not.toContain(token);
    expect(JSON.stringify(transport.sent)).not.toContain(token);
    // The assignment itself still holds it; nothing else does.
    expect(JSON.stringify(message)).toContain(token);
  });

  it("gives handlers empty credentials when none are sent", async () => {
    const seen: HandlerCredentials[] = [];
    const { runner, transport } = setup(
      (registry) => registry.register("producer.chat", leakyChat(seen)),
      { serverUrl: SERVER_URL },
    );
    assign(runner, { type: "producer.chat", payload: chatPayload });
    await settled(transport);
    expect(seen).toEqual([{}]);
  });

  it("ignores credentials for job types without MCP access or without a server URL", async () => {
    const seen: HandlerCredentials[] = [];
    const ping = setup(
      (registry) =>
        registry.register("system.ping", async (ctx) => {
          seen.push(ctx.credentials);
          return pingHandler(ctx);
        }),
      { serverUrl: SERVER_URL },
    );
    assign(ping.runner, { type: "system.ping" }, jobCredentials(testJobToken()));
    expect(await settled(ping.transport)).toMatchObject({ type: "job.complete" });

    const noServer = setup((registry) => registry.register("producer.chat", leakyChat(seen)));
    assign(
      noServer.runner,
      { type: "producer.chat", payload: chatPayload },
      jobCredentials(testJobToken()),
    );
    expect(await settled(noServer.transport)).toMatchObject({ type: "job.complete" });
    expect(seen).toEqual([{}, {}]);
  });

  it("rejects an assignment whose endpoint is not a server path", () => {
    const { runner, transport } = setup(
      (registry) => registry.register("producer.chat", leakyChat([])),
      { serverUrl: SERVER_URL },
    );
    const token = testJobToken();
    for (const endpoint of ["//attacker.example/mcp", "https://attacker.example/mcp"]) {
      const frame = JSON.stringify({
        v: 1,
        id: createUlid(),
        ts: new Date().toISOString(),
        type: "job.assign",
        payload: {
          job: {
            id: ids.job,
            type: "producer.chat",
            attempt: 1,
            payload: chatPayload,
            workspaceId: ids.workspace,
          },
          leaseMs: 600_000,
          credentials: jobCredentials(token, endpoint),
        },
      });
      const parsed = parseServerMessage(frame);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        runner.invalidFrame(frame, parsed);
      }
    }
    expect(transport.types()).toEqual(["job.reject", "job.reject"]);
    expect(JSON.stringify(transport.sent)).not.toContain(token);
  });
});

describe("chunkText", () => {
  it("splits long text without breaking surrogate pairs", () => {
    expect(chunkText("abcdef", 4)).toEqual(["abcd", "ef"]);
    expect(chunkText("abc😀def", 4)).toEqual(["abc", "😀de", "f"]);
    expect(chunkText("", 4)).toEqual([]);
  });
});
