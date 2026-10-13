/**
 * A fake studio agent for the smoke tests and for local development without a producer runtime.
 * It speaks the real bridge protocol through the contracts codec over a real WebSocket: it pairs
 * with `POST /api/bridge/pair`, connects to `/bridge/v1` with the device token, answers
 * `producer.chat` jobs with streamed text instead of a producer session, and answers
 * `kb.analyze_reference` jobs with a fixed, schema-valid analysis.
 *
 * As a script it pairs and then answers every message with an echo until stopped:
 *
 *   pnpm --filter @loomcast/e2e fake-agent --server http://localhost:5173 --code ABCD-EFGH
 */
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  type AgentToServerDraft,
  type AssignedJob,
  BRIDGE_PATH,
  type Credits,
  encode,
  type JobCredentials,
  type JobEvent,
  type KbAnalyzeReferencePayload,
  KbAnalyzeReferencePayloadSchema,
  type KbAnalyzeReferenceResult,
  KbAnalyzeReferenceResultSchema,
  PairResponseSchema,
  PROTOCOL_VERSION,
  type ProducerChatPayload,
  ProducerChatPayloadSchema,
  type ProducerChatResult,
  parseServerMessage,
  routes,
  type ServerMessageOf,
  type ServerToAgent,
} from "@loomcast/contracts";
import WebSocket from "ws";

const AGENT_VERSION = "0.0.0-e2e";
const PLATFORM = "e2e-fake";

/** One `producer.chat` job, with the calls a handler uses to answer it. */
export interface ChatTurn {
  readonly job: AssignedJob;
  readonly payload: ProducerChatPayload;
  /** The producer session this turn runs in: the payload's, or a new one. */
  readonly sessionId: string;
  /** The job's MCP credentials from `job.assign`, as a producer session would get them. */
  readonly credentials: JobCredentials | undefined;
  /** An ephemeral `job.stream` delta, shown in the UI while the reply is written. */
  stream(text: string): void;
  /** A durable `status` event. */
  status(state: string, message?: string): void;
  /** A durable `tool.activity` event. */
  activity(tool: string, summary: string): void;
  /** A durable `assistant.message` event: the stored reply. */
  reply(text: string): void;
}

/** Answers a turn. Returning resolves the job as succeeded with the last reply. */
export type ChatHandler = (turn: ChatTurn) => Promise<void> | void;

/** Analyses a reference. The result is checked against the job registry before it is sent. */
export type AnalyzeHandler = (
  payload: KbAnalyzeReferencePayload,
) => Promise<KbAnalyzeReferenceResult> | KbAnalyzeReferenceResult;

export interface PairedDevice {
  deviceId: string;
  token: string;
}

export interface FakeAgentOptions {
  /** The server the agent paired with, for example the web origin in development. */
  serverUrl: string;
  token: string;
  /** Defaults to `echoHandler`. */
  onChat?: ChatHandler;
  /** Defaults to `sampleAnalysisHandler`. */
  onAnalyze?: AnalyzeHandler;
}

/** Streams "You said: …" in two deltas, then stores it as the reply. */
export const echoHandler: ChatHandler = async (turn) => {
  turn.status("running", "Writing the reply");
  const reply = `You said: ${turn.payload.text}`;
  const middle = Math.ceil(reply.length / 2);
  turn.stream(reply.slice(0, middle));
  await delay(100);
  turn.stream(reply.slice(middle));
  turn.reply(reply);
};

/** A fixed analysis that names the first transcript line as the hook. */
export const sampleAnalysisHandler: AnalyzeHandler = (payload) => {
  const firstLine =
    (payload.transcript ?? "")
      .split("\n")
      .map((line) => line.replace(/^\[[\d:]+\]\s*/, "").trim())
      .find((line) => line !== "") ?? "The opening line";
  return {
    analysis: {
      hook: { text: firstLine.slice(0, 500), type: "question", timeToHookMs: 0 },
      structure: [
        { label: "Hook", startMs: 0, endMs: 3_000, summary: "Opens on the question." },
        { label: "Payoff", startMs: 3_000, endMs: 20_000, summary: "Answers it step by step." },
      ],
      pacing: { wordsPerMinute: 180, notes: "Fast, with no dead air." },
      retention: [{ technique: "Open loop", evidence: "The answer waits for the last beat." }],
      takeaways: ["Open on the question the viewer already has."],
      applicability: "Use a question hook for the next explainer.",
    },
    summaryMd: "A question hook answered step by step.",
  };
};

/** Calls an MCP tool with a job's credentials, as a producer session does; returns the result. */
export async function callMcpTool(
  serverUrl: string,
  credentials: JobCredentials,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError?: boolean; structuredContent?: Record<string, unknown> }> {
  const response = await fetch(new URL(credentials.mcp.endpoint, serverUrl), {
    method: "POST",
    headers: {
      authorization: `Bearer ${credentials.mcp.token}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const body = (await response.json()) as { result?: Record<string, unknown>; error?: unknown };
  if (response.status !== 200 || body.result === undefined) {
    throw new Error(`MCP ${name} failed with HTTP ${response.status}: ${JSON.stringify(body)}`);
  }
  return body.result as { isError?: boolean; structuredContent?: Record<string, unknown> };
}

/** Exchanges a pairing code for a device token, as `studio-agent pair` does. */
export async function pairDevice(
  serverUrl: string,
  code: string,
  name = "E2E Studio",
): Promise<PairedDevice> {
  const route = routes["bridge.pair"];
  const response = await fetch(new URL(route.path, serverUrl), {
    method: route.method,
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ code, name, platform: PLATFORM, agentVersion: AGENT_VERSION }),
  });
  const body: unknown = await response.json().catch(() => undefined);
  if (response.status !== 201) {
    throw new Error(`pairing failed with HTTP ${response.status}: ${JSON.stringify(body)}`);
  }
  return PairResponseSchema.parse(body);
}

/** The bridge URL on `serverUrl`: `ws://host/bridge/v1` (`wss` for https). */
export function bridgeUrl(serverUrl: string): string {
  const url = new URL(BRIDGE_PATH, serverUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export class FakeStudioAgent {
  readonly #options: FakeAgentOptions;
  #ws: WebSocket | null = null;
  #credits: Credits = { producer: 1, render: 0 };
  /** Every frame received, parsed. */
  readonly received: ServerToAgent[] = [];
  /** Payloads of the `producer.chat` jobs this agent ran, in order. */
  readonly turns: ProducerChatPayload[] = [];
  /** Payloads of the `kb.analyze_reference` jobs this agent ran, in order. */
  readonly analyses: KbAnalyzeReferencePayload[] = [];
  /** Results this agent sent with `job.complete`, by job id. */
  readonly results = new Map<string, ProducerChatResult>();
  /** Frames from the server that did not parse; the smoke expects none. */
  readonly invalidFrames: string[] = [];
  onChat: ChatHandler;
  onAnalyze: AnalyzeHandler;

  constructor(options: FakeAgentOptions) {
    this.#options = options;
    this.onChat = options.onChat ?? echoHandler;
    this.onAnalyze = options.onAnalyze ?? sampleAnalysisHandler;
  }

  get connected(): boolean {
    return this.#ws?.readyState === WebSocket.OPEN;
  }

  /** Connects, sends `hello` and resolves with `hello.ok`. */
  async connect(): Promise<ServerMessageOf<"hello.ok">["payload"]> {
    const ws = new WebSocket(bridgeUrl(this.#options.serverUrl), {
      headers: { authorization: `Bearer ${this.#options.token}` },
      perMessageDeflate: false,
    });
    this.#ws = ws;
    ws.on("message", (data) => this.#receive(data.toString()));
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("unexpected-response", (_request, response) => {
        response.resume();
        reject(new Error(`bridge upgrade refused with HTTP ${response.statusCode}`));
      });
      ws.once("error", reject);
    });
    const from = this.received.length;
    this.#send({
      type: "hello",
      payload: {
        protocol: PROTOCOL_VERSION,
        agentVersion: AGENT_VERSION,
        platform: PLATFORM,
        jobTypes: ["system.ping", "producer.chat", "kb.analyze_reference"],
        credits: this.#credits,
        resume: [],
      },
    });
    const ok = await waitFor(
      () => this.received.slice(from).find((message) => message.type === "hello.ok"),
      "hello.ok",
    );
    return (ok as ServerMessageOf<"hello.ok">).payload;
  }

  /** Closes the connection normally, as a stopped agent does. */
  async close(): Promise<void> {
    const ws = this.#ws;
    if (ws === null || ws.readyState === WebSocket.CLOSED) {
      return;
    }
    const closed = new Promise<void>((resolve) => ws.once("close", () => resolve()));
    ws.close(1000, "agent stopped");
    await closed;
  }

  #send(draft: AgentToServerDraft): void {
    this.#ws?.send(encode(draft));
  }

  #receive(frame: string): void {
    const parsed = parseServerMessage(frame);
    if (!parsed.ok) {
      this.invalidFrames.push(frame);
      return;
    }
    this.received.push(parsed.message);
    if (parsed.message.type === "job.assign") {
      const { job, credentials } = parsed.message.payload;
      void this.#run(job, credentials).catch((error: unknown) => {
        process.stderr.write(`[fake agent] job failed: ${(error as Error).message}\n`);
      });
    }
  }

  async #run(job: AssignedJob, credentials: JobCredentials | undefined): Promise<void> {
    if (job.type === "system.ping") {
      this.#send({ type: "job.accept", payload: { jobId: job.id } });
      this.#send({
        type: "job.complete",
        payload: {
          jobId: job.id,
          result: {
            agentVersion: AGENT_VERSION,
            runtime: { node: process.version, platform: PLATFORM },
            producerAvailable: false,
          },
        },
      });
      return;
    }
    if (job.type === "kb.analyze_reference") {
      await this.#analyze(job);
      return;
    }
    if (job.type !== "producer.chat") {
      this.#send({
        type: "job.reject",
        payload: { jobId: job.id, reason: "unsupported_job_type" },
      });
      return;
    }
    const payload = ProducerChatPayloadSchema.parse(job.payload);
    this.turns.push(payload);
    this.#send({ type: "job.accept", payload: { jobId: job.id } });
    this.#setCredits({ producer: this.#credits.producer - 1 });

    const started = Date.now();
    const sessionId = payload.producerSessionId ?? `e2e-session-${randomUUID()}`;
    let seq = 0;
    let lastReply = "";
    const event = (kind: JobEvent["kind"], data: JobEvent["data"]) => {
      seq += 1;
      this.#send({
        type: "job.event",
        payload: { jobId: job.id, seq, kind, data } as JobEvent,
      });
    };
    const turn: ChatTurn = {
      job,
      payload,
      sessionId,
      credentials,
      stream: (text) =>
        this.#send({
          type: "job.stream",
          payload: { jobId: job.id, kind: "assistant.delta", text },
        }),
      status: (state, message) => event("status", { state, message }),
      activity: (tool, summary) => event("tool.activity", { tool, summary }),
      reply: (text) => {
        lastReply = text;
        event("assistant.message", { text });
      },
    };

    event("session", { sessionId });
    try {
      await this.onChat(turn);
      const result: ProducerChatResult = {
        sdkSessionId: sessionId,
        finalText: lastReply,
        numTurns: 1,
        durationMs: Date.now() - started,
      };
      this.results.set(job.id, result);
      this.#send({ type: "job.complete", payload: { jobId: job.id, result } });
    } catch (error) {
      this.#send({
        type: "job.fail",
        payload: {
          jobId: job.id,
          error: { code: "producer_failed", message: (error as Error).message, retryable: true },
        },
      });
    } finally {
      this.#setCredits({ producer: this.#credits.producer + 1 });
    }
  }

  async #analyze(job: AssignedJob): Promise<void> {
    const payload = KbAnalyzeReferencePayloadSchema.parse(job.payload);
    this.analyses.push(payload);
    this.#send({ type: "job.accept", payload: { jobId: job.id } });
    this.#setCredits({ producer: this.#credits.producer - 1 });
    let seq = 0;
    const event = (kind: JobEvent["kind"], data: JobEvent["data"]) => {
      seq += 1;
      this.#send({ type: "job.event", payload: { jobId: job.id, seq, kind, data } as JobEvent });
    };
    try {
      event("status", { state: "running", message: "Reading the transcript" });
      const result = KbAnalyzeReferenceResultSchema.parse(await this.onAnalyze(payload));
      this.#send({ type: "job.complete", payload: { jobId: job.id, result } });
    } catch (error) {
      this.#send({
        type: "job.fail",
        payload: {
          jobId: job.id,
          error: { code: "analysis_invalid", message: (error as Error).message, retryable: false },
        },
      });
    } finally {
      this.#setCredits({ producer: this.#credits.producer + 1 });
    }
  }

  #setCredits(change: Partial<Credits>): void {
    this.#credits = { ...this.#credits, ...change };
    this.#send({ type: "credits", payload: this.#credits });
  }
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls `check` until it returns a value other than undefined or false. */
export async function waitFor<T>(
  check: () => T | undefined | false,
  what: string,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value !== undefined && value !== false) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await delay(20);
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      server: { type: "string" },
      code: { type: "string" },
      name: { type: "string", default: "Fake Studio" },
    },
  });
  if (values.server === undefined || values.code === undefined) {
    process.stderr.write("Usage: fake-agent --server <url> --code <XXXX-XXXX> [--name <name>]\n");
    process.exitCode = 2;
    return;
  }
  const device = await pairDevice(values.server, values.code, values.name);
  const agent = new FakeStudioAgent({ serverUrl: values.server, token: device.token });
  const hello = await agent.connect();
  process.stderr.write(`[fake agent] connected as device ${hello.deviceId}; Ctrl-C stops it\n`);
  const stop = () => void agent.close().then(() => process.exit(0));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

const entry = process.argv[1];
if (entry !== undefined && realpathSync(entry) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`[fake agent] ${(error as Error).message}\n`);
    process.exitCode = 1;
  });
}
