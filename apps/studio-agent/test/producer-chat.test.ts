import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type JobEventKind, parseJobResult } from "@loomcast/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { JobContext } from "../src/handlers";
import { producerChatHandler } from "../src/jobs/producer-chat";
import { silentLogger } from "../src/logger";
import {
  PRODUCER_ERROR_CODES,
  ProducerError,
  type ProducerRunInput,
  type ProducerRunResult,
  type ProducerRuntime,
  producerNotAuthenticated,
} from "../src/producer/runtime";
import { ProducerSessions } from "../src/producer/sessions";
import { ensureProjectWorkspace, PROJECT_FILE } from "../src/producer/workspace";
import { ids, tempAgentPaths } from "./helpers";

const conversationId = "3e9f5cab-b07d-4f4b-8c6e-5d4a7b8c9da3";
const messageId = "4fa06dbc-c18e-4a5c-9d7f-6e5b8c9daeb4";
const SERVER_SESSION = "server-session-1";
const CACHED_SESSION = "cached-session-1";
const NEW_SESSION = "new-session-1";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "loomcast-producer-chat-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A runtime that records its inputs and answers with `respond`. */
function fakeRuntime(
  respond: (
    input: ProducerRunInput,
    call: number,
  ) => Promise<ProducerRunResult> | ProducerRunResult,
): ProducerRuntime & { inputs: ProducerRunInput[] } {
  const inputs: ProducerRunInput[] = [];
  return {
    inputs,
    run: async (input) => {
      inputs.push(input);
      return respond(input, inputs.length);
    },
  };
}

function okResult(sessionId: string): ProducerRunResult {
  return { sessionId, finalText: "ready", numTurns: 1, durationMs: 42 };
}

interface ChatRun {
  readonly ctx: JobContext<"producer.chat">;
  readonly events: { kind: JobEventKind; data: unknown }[];
  readonly streamed: string[];
}

function chatContext(
  payload: Record<string, unknown> = {},
  signal = new AbortController().signal,
): ChatRun {
  const events: { kind: JobEventKind; data: unknown }[] = [];
  const streamed: string[] = [];
  const ctx: JobContext<"producer.chat"> = {
    job: {
      id: ids.job,
      type: "producer.chat",
      attempt: 1,
      projectId: ids.project,
      conversationId,
      payload: {
        conversationId,
        projectId: ids.project,
        messageId,
        text: "Reply with the word ready",
        ...payload,
      } as JobContext<"producer.chat">["job"]["payload"],
    },
    credentials: {},
    emit: (kind, data) => {
      events.push({ kind, data });
    },
    stream: (text) => streamed.push(text),
    signal,
    log: silentLogger,
  };
  return { ctx, events, streamed };
}

describe("producer.chat handler", () => {
  it("runs a new session in the project workspace and returns the registry result", async () => {
    const paths = tempAgentPaths();
    const runtime = fakeRuntime((input) => {
      input.onEvent({ kind: "session", data: { sessionId: NEW_SESSION } });
      input.onDelta("rea");
      input.onDelta("dy");
      input.onEvent({ kind: "assistant.message", data: { text: "ready" } });
      return okResult(NEW_SESSION);
    });
    const sessions = new ProducerSessions(paths);
    const handler = producerChatHandler({ runtime, sessions, workspaceRoot: root });
    const { ctx, events, streamed } = chatContext();

    const result = await handler(ctx);

    expect(parseJobResult("producer.chat", result).success).toBe(true);
    expect(result).toEqual({
      sdkSessionId: NEW_SESSION,
      finalText: "ready",
      numTurns: 1,
      durationMs: 42,
    });
    const input = runtime.inputs[0];
    expect(input?.resumeId).toBeUndefined();
    expect(input?.prompt).toBe("Reply with the word ready");
    expect(input?.cwd).toBe(realpathSync(join(root, "projects", ids.project)));
    expect(input?.signal).toBe(ctx.signal);
    expect(events.map((event) => event.kind)).toEqual(["status", "session", "assistant.message"]);
    expect(events[0]?.data).toEqual({ state: "starting" });
    expect(streamed).toEqual(["rea", "dy"]);
    expect(sessions.get(conversationId)).toBe(NEW_SESSION);
  });

  it("resumes the session the server sends", async () => {
    const paths = tempAgentPaths();
    const sessions = new ProducerSessions(paths);
    sessions.set(conversationId, CACHED_SESSION);
    const runtime = fakeRuntime((input) => okResult(input.resumeId ?? NEW_SESSION));
    const handler = producerChatHandler({ runtime, sessions, workspaceRoot: root });

    const result = await handler(chatContext({ producerSessionId: SERVER_SESSION }).ctx);

    expect(runtime.inputs[0]?.resumeId).toBe(SERVER_SESSION);
    expect(result.sdkSessionId).toBe(SERVER_SESSION);
    expect(sessions.get(conversationId)).toBe(SERVER_SESSION);
  });

  it("falls back to the cached session when the server sends none", async () => {
    const sessions = new ProducerSessions(tempAgentPaths());
    sessions.set(conversationId, CACHED_SESSION);
    const runtime = fakeRuntime((input) => okResult(input.resumeId ?? NEW_SESSION));
    const handler = producerChatHandler({ runtime, sessions, workspaceRoot: root });

    await handler(chatContext().ctx);

    expect(runtime.inputs[0]?.resumeId).toBe(CACHED_SESSION);
  });

  it("starts a new session when the one to resume is not on this Mac", async () => {
    const runtime = fakeRuntime((input, call) => {
      if (call === 1) {
        throw new ProducerError(PRODUCER_ERROR_CODES.sessionNotFound, "not found", false);
      }
      return okResult(input.resumeId ?? NEW_SESSION);
    });
    const handler = producerChatHandler({
      runtime,
      sessions: new ProducerSessions(tempAgentPaths()),
      workspaceRoot: root,
    });
    const { ctx, events } = chatContext({ producerSessionId: SERVER_SESSION });

    const result = await handler(ctx);

    expect(runtime.inputs.map((input) => input.resumeId)).toEqual([SERVER_SESSION, undefined]);
    expect(result.sdkSessionId).toBe(NEW_SESSION);
    expect(events.find((event) => event.kind === "log")?.data).toMatchObject({ level: "warn" });
  });

  it("fails with the runtime's error, such as a missing login", async () => {
    const runtime = fakeRuntime(() => {
      throw producerNotAuthenticated();
    });
    const handler = producerChatHandler({
      runtime,
      sessions: new ProducerSessions(tempAgentPaths()),
      workspaceRoot: root,
    });

    await expect(handler(chatContext().ctx)).rejects.toMatchObject({
      code: "producer_not_authenticated",
      message: "Log in to the producer runtime on this Mac",
      retryable: false,
    });
    expect(runtime.inputs).toHaveLength(1);
  });

  it("passes the job's abort signal to the runtime", async () => {
    const controller = new AbortController();
    const runtime = fakeRuntime(
      (input) =>
        new Promise<ProducerRunResult>((_resolve, reject) => {
          input.signal.addEventListener("abort", () => reject(input.signal.reason), {
            once: true,
          });
        }),
    );
    const handler = producerChatHandler({
      runtime,
      sessions: new ProducerSessions(tempAgentPaths()),
      workspaceRoot: root,
    });

    const running = handler(chatContext({}, controller.signal).ctx);
    await expect.poll(() => runtime.inputs.length).toBe(1);
    controller.abort(new Error("cancelled"));

    await expect(running).rejects.toThrow("cancelled");
  });

  it("rejects a payload whose project differs from the job's", async () => {
    const runtime = fakeRuntime(() => okResult(NEW_SESSION));
    const handler = producerChatHandler({
      runtime,
      sessions: new ProducerSessions(tempAgentPaths()),
      workspaceRoot: root,
    });

    await expect(
      handler(chatContext({ projectId: "5ab17ecd-d29f-4b6d-ae80-7f6c9daebfc5" }).ctx),
    ).rejects.toMatchObject({ code: "invalid_payload" });
    expect(runtime.inputs).toHaveLength(0);
  });
});

describe("project workspace", () => {
  it("creates the directory and a PROJECT.md stub once", async () => {
    const first = await ensureProjectWorkspace(root, ids.project, "Launch teaser");
    expect(first.created).toBe(true);
    expect(first.dir).toBe(realpathSync(join(root, "projects", ids.project)));
    expect(readFileSync(join(first.dir, PROJECT_FILE), "utf8")).toContain("# Launch teaser");

    writeFileSync(join(first.dir, PROJECT_FILE), "my notes");
    const second = await ensureProjectWorkspace(root, ids.project, "Renamed");
    expect(second.created).toBe(false);
    expect(readFileSync(join(second.dir, PROJECT_FILE), "utf8")).toBe("my notes");
  });

  it("only accepts a project id as the directory name", async () => {
    await expect(ensureProjectWorkspace(root, "../escape")).rejects.toThrow();
  });
});

describe("producer session cache", () => {
  it("stores sessions per conversation in a private file", () => {
    const paths = tempAgentPaths();
    const sessions = new ProducerSessions(paths);
    expect(sessions.get(conversationId)).toBeUndefined();

    sessions.set(conversationId, "s1");
    sessions.set(conversationId, "s2");

    expect(new ProducerSessions(paths).get(conversationId)).toBe("s2");
    expect(statSync(join(paths.home, "producer-sessions.json")).mode & 0o777).toBe(0o600);
  });

  it("treats an unreadable cache as empty", () => {
    const paths = tempAgentPaths();
    const sessions = new ProducerSessions(paths);
    sessions.set(conversationId, "s1");
    writeFileSync(join(paths.home, "producer-sessions.json"), "{not json");
    expect(sessions.get(conversationId)).toBeUndefined();
  });
});
