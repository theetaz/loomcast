/**
 * A fake studio agent for the smoke tests and for local development without a producer runtime.
 * It speaks the real bridge protocol through the contracts codec over a real WebSocket: it pairs
 * with `POST /api/bridge/pair`, connects to `/bridge/v1` with the device token, answers
 * `producer.chat` jobs with streamed text instead of a producer session, and answers
 * `kb.analyze_reference` jobs with a fixed, schema-valid analysis.
 *
 * It also runs the production jobs (`content.*` and `skills.sync`) the way the studio agent does,
 * without a producer session, the TTS provider or a renderer: it reads the item over MCP with the
 * job token (`content.get`, `asset.get_url`, `skill.pull`), answers with fixture JSON, and uploads
 * small synthetic media made at run time (bytes labelled MP3, MP4 or JPEG) through the presigned
 * PUT, then finalizes them with probe metadata (`content.upload_asset`, `content.finalize_asset`).
 * No media file is ever committed.
 *
 * As a script it pairs and then answers every message with an echo until stopped:
 *
 *   pnpm --filter @loomcast/e2e fake-agent --server http://localhost:5173 --code ABCD-EFGH
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  type AgentToServerDraft,
  type AlignedWord,
  type Asset,
  type AssetGetUrlOutput,
  type AssetKind,
  type AssetMimeType,
  type AssetProbe,
  type AssignedJob,
  BRIDGE_PATH,
  type ContentFinalizeAssetOutput,
  type ContentGetOutput,
  type ContentUploadAssetOutput,
  type Credits,
  encode,
  getJobDefinition,
  type JobCredentials,
  type JobEvent,
  type JobPayload,
  type JobResult,
  type KbAnalyzeReferencePayload,
  KbAnalyzeReferencePayloadSchema,
  type KbAnalyzeReferenceResult,
  KbAnalyzeReferenceResultSchema,
  PairResponseSchema,
  PROTOCOL_VERSION,
  type ProducerChatPayload,
  ProducerChatPayloadSchema,
  type ProducerChatResult,
  type PulledSkill,
  parseJobPayload,
  parseJobResult,
  parseServerMessage,
  routes,
  type Script,
  type ServerMessageOf,
  type ServerToAgent,
  type SkillPullOutput,
  type VoiceAlignment,
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
  /** Replaces some of the `fixtureProduction` handlers. */
  onProduce?: Partial<ProductionHandlers>;
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

/** The production job types the fake agent answers with fixtures. */
export const PRODUCTION_JOB_TYPES = [
  "content.write_script",
  "content.storyboard",
  "content.voice",
  "content.render",
  "content.revise",
  "skills.sync",
] as const;
export type ProductionJobType = (typeof PRODUCTION_JOB_TYPES)[number];

function isProductionJobType(type: string): type is ProductionJobType {
  return (PRODUCTION_JOB_TYPES as readonly string[]).includes(type);
}

/** A synthetic file the fake agent uploads in place of a real voice take, render or poster. */
export interface SyntheticFile {
  kind: AssetKind;
  mime: AssetMimeType;
  filename: string;
  probe: AssetProbe;
  /** A voice take's word timings. */
  alignment?: VoiceAlignment;
}

/** One production job, with the calls a handler uses to answer it. */
export interface ProductionStep<T extends ProductionJobType = ProductionJobType> {
  readonly job: AssignedJob;
  readonly type: T;
  readonly payload: JobPayload<T>;
  /** Calls an MCP tool with the job token; a tool error is thrown. */
  mcp<O>(name: string, args: Record<string, unknown>): Promise<O>;
  /** A durable `status` event, with progress from 0 to 1. */
  status(state: string, progress?: number): void;
  /** Pulls published skills (`skill.pull`), as the studio agent loads its skill pack. */
  pullSkills(names?: readonly string[]): Promise<PulledSkill[]>;
  /** Uploads synthetic bytes as `file` for the job's item and finalizes the asset. */
  upload(file: SyntheticFile): Promise<Asset>;
}

/** Answers a production job. The result is checked against the job registry before it is sent. */
export type ProductionHandler<T extends ProductionJobType> = (
  step: ProductionStep<T>,
) => Promise<JobResult<T>> | JobResult<T>;

export type ProductionHandlers = { [T in ProductionJobType]: ProductionHandler<T> };

/** One production job the agent ran: what it was asked and what it answered. */
export interface ProductionRecord {
  jobId: string;
  type: ProductionJobType;
  payload: Record<string, unknown>;
  result?: unknown;
  error?: string;
}

/** The magic bytes media players and sniffers look for, so the synthetic files look the part. */
const MAGIC: Partial<Record<AssetMimeType, Buffer>> = {
  "audio/mpeg": Buffer.from([0x49, 0x44, 0x33, 0x04, 0, 0, 0, 0, 0, 0]),
  "video/mp4": Buffer.concat([
    Buffer.from([0, 0, 0, 0x18]),
    Buffer.from("ftypisom", "latin1"),
    Buffer.from([0, 0, 0x02, 0]),
    Buffer.from("isommp41", "latin1"),
  ]),
  "image/jpeg": Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
};

/**
 * A few kilobytes that stand in for a media file: the format's magic bytes, a label and random
 * bytes, so every take, render and poster is a distinct file. Never a real recording.
 */
export function syntheticMedia(mime: AssetMimeType, label: string): Buffer {
  return Buffer.concat([
    MAGIC[mime] ?? Buffer.alloc(0),
    Buffer.from(`loomcast e2e synthetic media: ${label}\n`, "utf8"),
    randomBytes(4_096),
  ]);
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The spoken words of a script, in order. */
function scriptWords(script: Script): string[] {
  return script.segments.flatMap((segment) => segment.text.split(/\s+/).filter(Boolean));
}

/** Evenly spaced word timings over `durationMs`, standing in for the TTS provider's alignment. */
export function fixtureAlignment(script: Script, durationMs: number): VoiceAlignment {
  const words = scriptWords(script);
  const step = Math.max(1, Math.floor(durationMs / Math.max(1, words.length)));
  return {
    words: words.map(
      (text, index): AlignedWord => ({
        text: text.slice(0, 100),
        startMs: index * step,
        endMs: Math.min(durationMs, index * step + Math.max(1, step - 20)),
      }),
    ),
  };
}

/** Reads the job's item at the version the job starts from. */
async function readItem(
  step: ProductionStep<Exclude<ProductionJobType, "skills.sync">>,
): Promise<ContentGetOutput> {
  return step.mcp<ContentGetOutput>("content.get", {
    itemId: step.payload.itemId,
    versionId: step.payload.versionId,
  });
}

function requireScript(item: ContentGetOutput): Script {
  if (item.version.script === null) throw new Error("the version has no script");
  return item.version.script;
}

/** The fixture answers of every production job. */
export const fixtureProduction: ProductionHandlers = {
  async "content.write_script"(step) {
    step.status("starting");
    const skills = await step.pullSkills();
    const { item } = await readItem(step);
    const { rules } = step.payload.format;
    const hook = `${item.title}: here is the one idea that makes it click.`.slice(0, 500);
    const durationMs = Math.round(((rules.lengthSec.min + rules.lengthSec.max) / 2) * 1_000);
    step.status("writing", 0.5);
    return {
      script: {
        title: item.title,
        hook,
        segments: [
          { id: "hook", text: hook, onScreenText: item.title.slice(0, 280) },
          { id: "problem", text: "First, picture the problem the way the viewer meets it." },
          { id: "fix", text: "Then show the fix one step at a time, with the code on screen." },
          { id: "cta", text: "Follow for the next one in the series." },
        ],
        cta: "Follow for the next one in the series.",
        caption: item.pitch ?? item.title,
        hashtags: [...rules.caption.hashtags],
        estimatedDurationMs: durationMs,
      },
      notes: `Fixture script from the e2e studio agent (${skills.length} skills loaded).`,
    };
  },

  async "content.storyboard"(step) {
    step.status("starting");
    const script = requireScript(await readItem(step));
    const { styleId } = step.payload.format.rules.visualTemplate;
    const span = Math.floor(script.estimatedDurationMs / script.segments.length);
    return {
      storyboard: {
        styleId,
        fps: 30,
        aspect: "9:16",
        frames: script.segments.map((segment, index) => ({
          id: `frame-${index + 1}`,
          segmentId: segment.id,
          startMs: index * span,
          endMs: (index + 1) * span,
          cardId: `${styleId}.t1.${index === 0 ? "title" : "section"}`,
          slots: { headline: (segment.onScreenText ?? segment.text).slice(0, 280) },
        })),
      },
    };
  },

  async "content.voice"(step) {
    step.status("starting");
    const script = requireScript(await readItem(step));
    step.status("synthesizing", 0.4);
    const durationMs = script.estimatedDurationMs;
    const alignment = fixtureAlignment(script, durationMs);
    step.status("uploading", 0.8);
    const asset = await step.upload({
      kind: "voice",
      mime: "audio/mpeg",
      filename: "voice.mp3",
      probe: {
        durationMs,
        audioCodec: "mp3",
        sampleRate: 44_100,
        channels: 1,
        bitRate: 128_000,
        formatName: "mp3",
      },
      alignment,
    });
    return { voiceAssetId: asset.id, durationMs, alignment };
  },

  async "content.render"(step) {
    step.status("starting");
    const item = await readItem(step);
    if (item.version.storyboard === null) throw new Error("the version has no storyboard");
    // The studio agent downloads the voice take when it was made on another Mac.
    const voice = await step.mcp<AssetGetUrlOutput>("asset.get_url", {
      assetId: step.payload.voiceAssetId,
    });
    const download = await fetch(voice.url);
    const bytes = new Uint8Array(await download.arrayBuffer());
    if (!download.ok || sha256Hex(bytes) !== voice.asset.sha256) {
      throw new Error(`the voice take did not download intact (HTTP ${download.status})`);
    }
    const durationMs = voice.asset.durationMs ?? item.version.storyboard.frames.at(-1)?.endMs ?? 1;
    for (const progress of [0.1, 0.5, 0.9]) step.status("rendering", progress);
    const frame = { width: 1_080, height: 1_920 };
    const render = await step.upload({
      kind: "render",
      mime: "video/mp4",
      filename: "final.mp4",
      probe: {
        durationMs,
        ...frame,
        fps: 30,
        videoCodec: "h264",
        audioCodec: "aac",
        sampleRate: 48_000,
        channels: 2,
        formatName: "mov,mp4,m4a,3gp,3g2,mj2",
      },
    });
    const poster = await step.upload({
      kind: "poster",
      mime: "image/jpeg",
      filename: "poster.jpg",
      probe: { ...frame, formatName: "image2" },
    });
    return { renderAssetId: render.id, posterAssetId: poster.id, durationMs, ...frame };
  },

  async "content.revise"(step) {
    step.status("starting");
    const script = requireScript(await readItem(step));
    const request = step.payload.instructions ?? "Tighten the hook.";
    const hook = request.replace(/\s+/g, " ").trim().slice(0, 500);
    // The spoken times belong to the old voice; the revised script is timed again after voice.
    const segments = script.segments.map(({ startMs: _start, endMs: _end, ...segment }, index) =>
      index === 0 ? { ...segment, text: hook } : segment,
    );
    return {
      script: { ...script, hook, segments },
      summary: `Rewrote the hook as the review asked: ${hook}`.slice(0, 2_000),
    };
  },

  async "skills.sync"(step) {
    const skills = await step.pullSkills(step.payload.names);
    return { synced: skills.map((skill) => ({ name: skill.name, version: skill.version })) };
  },
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
  #credits: Credits = { producer: 1, render: 1 };
  /** Every frame received, parsed. */
  readonly received: ServerToAgent[] = [];
  /** Payloads of the `producer.chat` jobs this agent ran, in order. */
  readonly turns: ProducerChatPayload[] = [];
  /** Payloads of the `kb.analyze_reference` jobs this agent ran, in order. */
  readonly analyses: KbAnalyzeReferencePayload[] = [];
  /** Results this agent sent with `job.complete`, by job id. */
  readonly results = new Map<string, ProducerChatResult>();
  /** Production jobs this agent ran, in the order they were assigned. */
  readonly productions: ProductionRecord[] = [];
  /** The skills each `skill.pull` returned, as `name@version` lists. */
  readonly skillPulls: string[][] = [];
  /** Frames from the server that did not parse; the smoke expects none. */
  readonly invalidFrames: string[] = [];
  onChat: ChatHandler;
  onAnalyze: AnalyzeHandler;
  onProduce: ProductionHandlers;

  constructor(options: FakeAgentOptions) {
    this.#options = options;
    this.onChat = options.onChat ?? echoHandler;
    this.onAnalyze = options.onAnalyze ?? sampleAnalysisHandler;
    this.onProduce = { ...fixtureProduction, ...options.onProduce } as ProductionHandlers;
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
        jobTypes: ["system.ping", "producer.chat", "kb.analyze_reference", ...PRODUCTION_JOB_TYPES],
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
    if (isProductionJobType(job.type)) {
      await this.#produce(job, job.type, credentials);
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

  /**
   * Runs a production job the way the studio agent does, with fixtures in place of producer
   * sessions, the TTS provider and the renderer. Every MCP call uses the job's own token.
   */
  async #produce(
    job: AssignedJob,
    type: ProductionJobType,
    credentials: JobCredentials | undefined,
  ): Promise<void> {
    const record: ProductionRecord = {
      jobId: job.id,
      type,
      payload: job.payload as Record<string, unknown>,
    };
    this.productions.push(record);
    const cls = getJobDefinition(type).concurrencyClass;
    this.#send({ type: "job.accept", payload: { jobId: job.id } });
    this.#setCredits({ [cls]: this.#credits[cls] - 1 });
    let seq = 0;
    const event = (kind: JobEvent["kind"], data: JobEvent["data"]) => {
      seq += 1;
      this.#send({ type: "job.event", payload: { jobId: job.id, seq, kind, data } as JobEvent });
    };
    const serverUrl = this.#options.serverUrl;
    const mcp = async <O>(name: string, args: Record<string, unknown>): Promise<O> => {
      if (credentials === undefined) throw new Error(`${type} came without MCP credentials`);
      const result = await callMcpTool(serverUrl, credentials, name, args);
      if (result.isError || result.structuredContent === undefined) {
        throw new Error(`${name} failed: ${JSON.stringify(result)}`);
      }
      return result.structuredContent as O;
    };
    try {
      const parsed = parseJobPayload(type, job.payload);
      if (!parsed.success) throw new Error(`invalid ${type} payload: ${parsed.error.message}`);
      const payload = parsed.data as Record<string, unknown>;
      const step: ProductionStep = {
        job,
        type,
        payload: parsed.data,
        mcp,
        status: (state, progress) =>
          event("status", progress === undefined ? { state } : { state, progress }),
        pullSkills: async (names) => {
          const pulled: PulledSkill[] = [];
          if (names === undefined) {
            pulled.push(...(await mcp<SkillPullOutput>("skill.pull", {})).skills);
          } else {
            for (const name of names) {
              pulled.push(...(await mcp<SkillPullOutput>("skill.pull", { name })).skills);
            }
          }
          this.skillPulls.push(pulled.map((skill) => `${skill.name}@${skill.version}`));
          return pulled;
        },
        upload: (file) => uploadSynthetic(mcp, String(payload.itemId), file),
      };
      const handler = this.onProduce[type] as ProductionHandler<ProductionJobType>;
      const answer = await handler(step);
      const result = parseJobResult(type, answer);
      if (!result.success) throw new Error(`invalid ${type} result: ${result.error.message}`);
      record.result = result.data;
      this.#send({ type: "job.complete", payload: { jobId: job.id, result: result.data } });
    } catch (error) {
      record.error = (error as Error).message;
      this.#send({
        type: "job.fail",
        payload: {
          jobId: job.id,
          // The bridge refuses error messages over 2,000 characters.
          error: {
            code: "production_failed",
            message: record.error.slice(0, 2_000),
            retryable: false,
          },
        },
      });
    } finally {
      this.#setCredits({ [cls]: this.#credits[cls] + 1 });
    }
  }

  #setCredits(change: Partial<Credits>): void {
    this.#credits = { ...this.#credits, ...change };
    this.#send({ type: "credits", payload: this.#credits });
  }
}

/**
 * Uploads a synthetic file for an item as the studio agent uploads a real one: asks for an upload
 * with the size and SHA-256, PUTs the bytes with exactly the signed headers, then finalizes the
 * asset with the probe (and a voice take's alignment). An identical ready file needs no upload.
 */
async function uploadSynthetic(
  mcp: <O>(name: string, args: Record<string, unknown>) => Promise<O>,
  itemId: string,
  file: SyntheticFile,
): Promise<Asset> {
  const bytes = syntheticMedia(file.mime, `${file.kind} ${file.filename}`);
  const requested = await mcp<ContentUploadAssetOutput>("content.upload_asset", {
    itemId,
    kind: file.kind,
    filename: file.filename,
    mime: file.mime,
    bytes: bytes.length,
    sha256: sha256Hex(bytes),
  });
  if (requested.upload === null) {
    return requested.asset;
  }
  const put = await fetch(requested.upload.url, {
    method: requested.upload.method,
    headers: requested.upload.headers,
    body: new Uint8Array(bytes),
  });
  if (!put.ok) {
    throw new Error(`the store refused the ${file.kind} upload: HTTP ${put.status}`);
  }
  await put.body?.cancel();
  const { asset } = await mcp<ContentFinalizeAssetOutput>("content.finalize_asset", {
    assetId: requested.asset.id,
    probe: file.probe,
    ...(file.alignment === undefined ? {} : { alignment: file.alignment }),
  });
  if (asset.status !== "ready") {
    throw new Error(`the server did not accept the ${file.kind} upload (${asset.status})`);
  }
  return asset;
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
