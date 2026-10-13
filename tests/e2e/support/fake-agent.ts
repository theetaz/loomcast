/**
 * A fake studio agent for the smoke tests and for local development without a producer runtime.
 * It speaks the real bridge protocol through the contracts codec over a real WebSocket: it pairs
 * with `POST /api/bridge/pair`, connects to `/bridge/v1` with the device token, and answers
 * `producer.chat` jobs with streamed text instead of a producer session.
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
  type JobEvent,
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
  /** Results this agent sent with `job.complete`, by job id. */
  readonly results = new Map<string, ProducerChatResult>();
  /** Frames from the server that did not parse; the smoke expects none. */
  readonly invalidFrames: string[] = [];
  onChat: ChatHandler;

  constructor(options: FakeAgentOptions) {
    this.#options = options;
    this.onChat = options.onChat ?? echoHandler;
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
        jobTypes: ["system.ping", "producer.chat"],
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
      void this.#run(parsed.message.payload.job).catch((error: unknown) => {
        process.stderr.write(`[fake agent] job failed: ${(error as Error).message}\n`);
      });
    }
  }

  async #run(job: AssignedJob): Promise<void> {
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
