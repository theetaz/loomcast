import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JobFailure } from "../src/handlers";
import type { ProducerEvent, ProducerRunInput } from "../src/producer/runtime";
import {
  classifyFailure,
  DeltaBatcher,
  PRODUCER_BRIEF,
  producerEnv,
  SdkProducerRuntime,
} from "../src/producer/sdk-runtime";
import { aborted, testJobToken } from "./helpers";
import {
  assistantText,
  assistantToolUse,
  errorResult,
  fakeQuery,
  initMessage,
  SESSION_ID,
  successResult,
  textDelta,
} from "./producer-fakes";

let cwd: string;

beforeEach(() => {
  cwd = realpathSync(mkdtempSync(join(tmpdir(), "loomcast-producer-runtime-")));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
  vi.useRealTimers();
});

interface Recorded {
  readonly events: ProducerEvent[];
  readonly deltas: string[];
  readonly input: ProducerRunInput;
}

function runInput(overrides: Partial<ProducerRunInput> = {}): Recorded {
  const events: ProducerEvent[] = [];
  const deltas: string[] = [];
  const input: ProducerRunInput = {
    prompt: "Draft a hook for the video",
    cwd,
    signal: new AbortController().signal,
    onEvent: (event) => events.push(event),
    onDelta: (text) => deltas.push(text),
    ...overrides,
  };
  return { events, deltas, input };
}

describe("SdkProducerRuntime", () => {
  it("captures the session id from init and maps messages to durable events", async () => {
    const fake = fakeQuery(() => [
      initMessage(),
      assistantToolUse("Read", { file_path: join(cwd, "notes", "brief.md") }),
      assistantToolUse("WebFetch", { url: "https://example.com/post?token=secret#x" }),
      assistantText("Here is the hook."),
      successResult("Here is the hook."),
    ]);
    const runtime = new SdkProducerRuntime({ query: fake.query });
    const { events, input } = runInput();

    const result = await runtime.run(input);

    expect(result).toEqual({
      sessionId: SESSION_ID,
      finalText: "Here is the hook.",
      numTurns: 2,
      durationMs: 1234,
    });
    expect(events).toEqual([
      { kind: "session", data: { sessionId: SESSION_ID } },
      { kind: "status", data: { state: "running" } },
      { kind: "tool.activity", data: { tool: "Read", summary: join("notes", "brief.md") } },
      { kind: "tool.activity", data: { tool: "WebFetch", summary: "https://example.com/post" } },
      { kind: "assistant.message", data: { text: "Here is the hook." } },
      {
        kind: "usage",
        data: {
          inputTokens: 10,
          outputTokens: 20,
          cacheReadTokens: 30,
          cacheCreationTokens: 40,
          costUsd: 0.0125,
        },
      },
    ]);
    expect(fake.calls[0]?.prompt).toBe("Draft a hook for the video");
    expect(fake.closed).toBe(1);
  });

  it("starts a new session without resume and passes resume through", async () => {
    const fake = fakeQuery(() => [initMessage(), successResult("ok")]);
    const runtime = new SdkProducerRuntime({ query: fake.query });

    await runtime.run(runInput().input);
    await runtime.run(runInput({ resumeId: SESSION_ID }).input);

    expect(fake.calls[0]?.options).not.toHaveProperty("resume");
    expect(fake.calls[1]?.options.resume).toBe(SESSION_ID);
    expect(fake.calls[1]?.options.cwd).toBe(cwd);
  });

  it("isolates the session: no settings, limited tools, guarded permissions", async () => {
    const fake = fakeQuery(() => [initMessage(), successResult("ok")]);
    const runtime = new SdkProducerRuntime({
      query: fake.query,
      env: { PATH: "/usr/bin", ANTHROPIC_API_KEY: "never-used", OTHER_API_KEY: "x" },
    });

    await runtime.run(runInput().input);
    const options = fake.calls[0]?.options;

    expect(options?.settingSources).toEqual([]);
    expect(options?.tools).toEqual([
      "Read",
      "Glob",
      "Grep",
      "Write",
      "Edit",
      "WebSearch",
      "WebFetch",
    ]);
    expect(options?.disallowedTools).toContain("Bash");
    expect(options?.allowedTools).toBeUndefined();
    expect(options?.permissionMode).toBe("default");
    expect(typeof options?.canUseTool).toBe("function");
    expect(options?.mcpServers).toEqual({});
    expect(options?.strictMcpConfig).toBe(true);
    expect(options?.includePartialMessages).toBe(true);
    expect(options?.abortController).toBeInstanceOf(AbortController);
    expect(options?.systemPrompt).toEqual({
      type: "preset",
      preset: "claude_code",
      append: PRODUCER_BRIEF,
    });
    expect(options?.env?.PATH).toBe("/usr/bin");
    expect(options?.env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(options?.env).not.toHaveProperty("OTHER_API_KEY");
  });

  it("attaches the platform MCP server with the job token for chat", async () => {
    const fake = fakeQuery(() => [initMessage(), successResult("ok")]);
    const runtime = new SdkProducerRuntime({ query: fake.query });
    const token = testJobToken();

    await runtime.run(
      runInput({
        jobType: "producer.chat",
        mcp: { url: new URL("http://127.0.0.1:8790/mcp"), token },
        brief: "Project brief",
      }).input,
    );
    const options = fake.calls[0]?.options;

    expect(options?.mcpServers).toEqual({
      loomcast: {
        type: "http",
        url: "http://127.0.0.1:8790/mcp",
        headers: { Authorization: `Bearer ${token}` },
        alwaysLoad: true,
      },
    });
    expect(options?.strictMcpConfig).toBe(true);
    expect(options?.allowedTools).toBeUndefined();
    expect(options?.systemPrompt).toMatchObject({ append: "Project brief" });
    expect(options?.disallowedTools).toEqual(
      expect.arrayContaining([
        "mcp__loomcast__kb_save_session_summary",
        "mcp__loomcast__project_create",
        "mcp__loomcast__admin_create_user",
      ]),
    );
    expect(options?.disallowedTools).not.toContain("mcp__loomcast__kb_save_brainstorm");
    expect(options?.disallowedTools).not.toContain("WebFetch");
    const decision = await options?.canUseTool?.(
      "mcp__loomcast__kb_save_brainstorm",
      { projectId: "p" },
      { signal: new AbortController().signal, toolUseID: "t1", requestId: "r1" },
    );
    expect(decision?.behavior).toBe("allow");
  });

  it("denies Bash through the guard it installs", async () => {
    const fake = fakeQuery(() => [initMessage(), successResult("ok")]);
    await new SdkProducerRuntime({ query: fake.query }).run(runInput().input);
    const canUseTool = fake.calls[0]?.options.canUseTool;

    const decision = await canUseTool?.(
      "Bash",
      { command: "rm -rf ~" },
      { signal: new AbortController().signal, toolUseID: "t1", requestId: "r1" },
    );
    expect(decision?.behavior).toBe("deny");
  });

  it("batches stream deltas and flushes them before the complete message", async () => {
    vi.useFakeTimers();
    const fake = fakeQuery(async function* () {
      yield initMessage();
      yield textDelta("Hel");
      yield textDelta("lo");
      await vi.advanceTimersByTimeAsync(100);
      yield textDelta(" wor");
      yield textDelta("ld");
      yield assistantText("Hello world");
      yield successResult("Hello world");
    });
    const runtime = new SdkProducerRuntime({ query: fake.query, deltaBatchMs: 100 });
    const { deltas, events, input } = runInput({
      onDelta: (text) => {
        deltas.push(text);
        events.push({ kind: "status", data: { state: `delta:${text}` } });
      },
    });

    await runtime.run(input);

    expect(deltas).toEqual(["Hello", " world"]);
    const order = events.map((event) => (event.kind === "status" ? event.data.state : event.kind));
    expect(order).toEqual([
      "session",
      "running",
      "delta:Hello",
      "delta: world",
      "assistant.message",
      "usage",
    ]);
  });

  it("aborts the session when the job signal aborts", async () => {
    const controller = new AbortController();
    let sessionAborted = false;
    const fake = fakeQuery(async function* (options) {
      yield initMessage();
      const signal = options.abortController?.signal as AbortSignal;
      controller.abort(new JobFailure("cancelled", "The job was cancelled"));
      await aborted(signal);
      sessionAborted = signal.aborted;
      throw new Error("Operation aborted");
    });
    const runtime = new SdkProducerRuntime({ query: fake.query });

    await expect(runtime.run(runInput({ signal: controller.signal }).input)).rejects.toMatchObject({
      code: "cancelled",
    });
    expect(sessionAborted).toBe(true);
    expect(fake.closed).toBe(1);
  });

  it("does not start when the signal is already aborted", async () => {
    const fake = fakeQuery(() => [initMessage(), successResult("ok")]);
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    await expect(
      new SdkProducerRuntime({ query: fake.query }).run(
        runInput({ signal: controller.signal }).input,
      ),
    ).rejects.toThrow("stop");
    expect(fake.calls).toHaveLength(0);
  });

  describe("errors", () => {
    const notAuthenticated = {
      code: "producer_not_authenticated",
      message: "Log in to the producer runtime on this Mac",
      retryable: false,
    };

    async function failure(messages: () => AsyncGenerator<SDKMessage, void> | SDKMessage[]) {
      const runtime = new SdkProducerRuntime({ query: fakeQuery(messages).query });
      return runtime.run(runInput().input).then(
        () => {
          throw new Error("expected the run to fail");
        },
        (error: unknown) => error,
      );
    }

    it("maps an authentication failure message to producer_not_authenticated", async () => {
      const error = await failure(() => [
        initMessage(),
        assistantText("Not logged in · Please run /login", "authentication_failed"),
        successResult("Not logged in · Please run /login", { is_error: true }),
      ]);
      expect(error).toBeInstanceOf(JobFailure);
      expect((error as JobFailure).toJobError()).toEqual(notAuthenticated);
    });

    it("maps a not-logged-in error result to producer_not_authenticated", async () => {
      const error = await failure(() => [errorResult("error_during_execution", ["Not logged in"])]);
      expect((error as JobFailure).toJobError()).toEqual(notAuthenticated);
    });

    it("maps a not-logged-in process failure to producer_not_authenticated", async () => {
      // biome-ignore lint/correctness/useYield: the stream fails before its first message
      const error = await failure(async function* () {
        throw new Error("Not logged in · Please run /login");
      });
      expect((error as JobFailure).toJobError()).toEqual(notAuthenticated);
    });

    it("reports a missing session to resume", async () => {
      const error = await failure(() => [
        errorResult("error_during_execution", [
          `No conversation found with session ID: ${SESSION_ID}`,
        ]),
      ]);
      expect((error as JobFailure).code).toBe("producer_session_not_found");
    });

    it("fails when the stream ends without a result", async () => {
      const error = await failure(() => [initMessage()]);
      expect((error as JobFailure).toJobError()).toMatchObject({
        code: "producer_failed",
        retryable: true,
      });
    });

    it("classifies service and account errors", () => {
      expect(classifyFailure("overloaded", []).toJobError()).toMatchObject({
        code: "producer_unavailable",
        retryable: true,
      });
      expect(classifyFailure("billing_error", []).code).toBe("producer_account_unavailable");
      expect(classifyFailure(undefined, ["boom"]).toJobError()).toEqual({
        code: "producer_failed",
        message: "boom",
        retryable: false,
      });
    });
  });
});

describe("producerEnv", () => {
  it("removes API-key variables and keeps the rest", () => {
    const env = producerEnv({
      PATH: "/bin",
      HOME: "/Users/me",
      ANTHROPIC_API_KEY: "a",
      ANTHROPIC_AUTH_TOKEN: "b",
      OPENAI_APIKEY: "c",
      some_api_key: "d",
      CLAUDECODE: "1",
      UNSET: undefined,
    });
    expect(Object.keys(env).sort()).toEqual(["CLAUDE_AGENT_SDK_CLIENT_APP", "HOME", "PATH"]);
  });
});

describe("DeltaBatcher", () => {
  it("passes text on at most once per interval", () => {
    vi.useFakeTimers();
    const out: string[] = [];
    const batcher = new DeltaBatcher(100, (text) => out.push(text));

    batcher.push("a");
    batcher.push("b");
    vi.advanceTimersByTime(99);
    expect(out).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(out).toEqual(["ab"]);

    batcher.push("c");
    batcher.push("");
    batcher.flush();
    batcher.flush();
    expect(out).toEqual(["ab", "c"]);
    vi.advanceTimersByTime(500);
    expect(out).toEqual(["ab", "c"]);
  });
});
