import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type Asset,
  type AssetDetail,
  type AssetKind,
  type ContentGetOutput,
  type ContentItem,
  type ContentVersion,
  DEFAULT_FORMAT_RULES,
  type FormatRules,
  type JobEventData,
  type JobEventKind,
  type JobPayload,
  type JobType,
  type PulledSkill,
  type Script,
  type Storyboard,
  type VoiceAlignment,
} from "@loomcast/contracts";
import {
  type BundledSkill,
  type Card,
  type CardRegistry,
  cardCatalogue,
  type MediaProbe,
  type RenderItemOptions,
  type RenderItemResult,
  type SynthesizeVoiceOptions,
  type TranscribeOptions,
  validateStoryboard,
} from "@loomcast/studio/runtime";
import { afterEach } from "vitest";
import {
  createMcpCredentials,
  type HandlerCredentials,
  type JobContext,
  type McpCredentials,
} from "../src/handlers";
import { silentLogger } from "../src/logger";
import type { ProducerRunInput, ProducerRunResult, ProducerRuntime } from "../src/producer/runtime";
import type { ProducerStepDeps } from "../src/production/context";
import { type PlatformClient, PlatformError } from "../src/production/platform";
import { skillChecksum } from "../src/production/skills";
import type { StudioRuntime } from "../src/production/studio";
import type { FetchLike } from "../src/production/upload";
import { ids, testJobToken } from "./helpers";
import { SESSION_ID } from "./producer-fakes";

// Fakes for the production jobs: a platform that keeps assets in memory, a studio runtime that
// writes small files instead of synthesizing or rendering, a producer runtime that answers from a
// script, and a fetch that plays the object store. Nothing here touches the network.

export const itemId = "3e9f5c0a-b07d-4f4b-8c6e-5d4a7b8c9d03";
export const versionId = "4fa06d1b-c18e-4a5c-9d7f-6e5b8c9dae14";
export const voiceAssetId = "5ab17ecd-d29f-4b6d-ae80-7f6c9daebf25";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A temporary directory removed after the test. */
export function tempDir(prefix = "loomcast-production-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

export const script: Script = {
  title: "Why your build is slow",
  hook: "Your build is slow for one boring reason.",
  segments: [
    { id: "s1", text: "Your build is slow for one boring reason." },
    { id: "s2", text: "It rebuilds everything because the cache key changes every run." },
    { id: "s3", text: "Pin the inputs and the cache works again." },
  ],
  cta: "Follow for more build fixes.",
  caption: "One change that makes builds fast again.",
  hashtags: ["devops", "builds"],
  estimatedDurationMs: 12_000,
};

export const STYLE_ID = "test-style";

/** A small card registry: two cards with text slots. */
export function testRegistry(): CardRegistry {
  const cards: Card[] = [
    {
      id: "test-style.t1.title",
      styleId: STYLE_ID,
      tier: "tier1",
      purpose: "section",
      file: "/dev/null",
      slots: [{ name: "headline", type: "text", maxChars: 40 }],
      duration: { min: 2, max: 8 },
    },
    {
      id: "test-style.t2.label",
      styleId: STYLE_ID,
      tier: "tier2",
      purpose: "label",
      file: "/dev/null",
      slots: [{ name: "label", type: "text", maxChars: 30 }],
      duration: { min: 2, max: 8 },
    },
  ];
  const style = {
    id: STYLE_ID,
    name: "Test style",
    dir: "/dev/null",
    tokens: "/dev/null",
    palette: {},
    fonts: {},
    cards,
  };
  return {
    libraryDir: "/dev/null",
    styles: [style],
    getStyle: (id) => (id === STYLE_ID ? style : undefined),
    getCard: (id) => cards.find((card) => card.id === id),
    findCards: (styleId) => (styleId === STYLE_ID ? cards : []),
  };
}

export const storyboard: Storyboard = {
  styleId: STYLE_ID,
  fps: 30,
  aspect: "9:16",
  frames: [
    {
      id: "f1",
      segmentId: "s1",
      startMs: 0,
      endMs: 4_000,
      cardId: "test-style.t1.title",
      slots: { headline: "One boring reason" },
    },
    {
      id: "f2",
      segmentId: "s2",
      startMs: 4_000,
      endMs: 9_000,
      cardId: "test-style.t2.label",
      slots: { label: "Cache keys" },
    },
  ],
};

export const alignment: VoiceAlignment = {
  words: [
    { text: "Your", startMs: 0, endMs: 200 },
    { text: "build", startMs: 220, endMs: 500 },
  ],
};

export function rules(overrides: Partial<FormatRules> = {}): FormatRules {
  const base = structuredClone(DEFAULT_FORMAT_RULES);
  return {
    ...base,
    voiceId: "voice-test",
    visualTemplate: { styleId: STYLE_ID, captions: { enabled: true, style: "word" } },
    ...overrides,
  };
}

export function contentItem(overrides: Partial<ContentItem> = {}): ContentItem {
  return {
    id: itemId,
    projectId: ids.project,
    seriesId: null,
    title: "Why your build is slow",
    pitch: "Explain cache keys in builds.",
    topic: "build caching",
    state: "script",
    currentVersionId: versionId,
    versionNo: 3,
    format: "reel",
    durationMs: null,
    posterAssetId: null,
    targetAt: null,
    autopilotTarget: null,
    lastError: null,
    createdVia: "ui",
    createdBy: null,
    createdAt: "2026-10-13T08:00:00.000Z",
    updatedAt: "2026-10-13T08:00:00.000Z",
    archivedAt: null,
    ...overrides,
  };
}

export function contentVersion(overrides: Partial<ContentVersion> = {}): ContentVersion {
  return {
    id: versionId,
    itemId,
    versionNo: 3,
    stage: "script",
    parentVersionId: null,
    formatVersionId: null,
    hasScript: true,
    format: "reel",
    media: [],
    hasStoryboard: false,
    voiceAssetId: null,
    renderAssetId: null,
    posterAssetId: null,
    notes: null,
    createdVia: "job",
    createdByUser: null,
    jobId: null,
    createdAt: "2026-10-13T08:00:00.000Z",
    script,
    storyboard: null,
    caption: null,
    ...overrides,
  };
}

export const STORE_URL = "http://store.test";

/** An asset the fake platform keeps, with the object's bytes once they are PUT. */
interface StoredAsset {
  asset: AssetDetail;
  bytes?: Buffer;
}

/**
 * A platform that keeps content and assets in memory. Uploads go to `STORE_URL/<assetId>`; the
 * fake fetch below stores what is PUT there, and finalize checks the bytes like the server does.
 */
export class FakePlatform implements PlatformClient {
  readonly calls: { tool: string; input: unknown }[] = [];
  readonly assets = new Map<string, StoredAsset>();
  content: ContentGetOutput;
  skills: PulledSkill[] = [];
  /** Answers `content.finalize_asset` with `upload_missing` this many times. */
  missingOnFinalize = 0;
  closed = 0;

  constructor(content: ContentGetOutput) {
    this.content = content;
  }

  async getContent(input: { itemId: string; versionId?: string }): Promise<ContentGetOutput> {
    this.calls.push({ tool: "content.get", input });
    return structuredClone(this.content);
  }

  async uploadAsset(input: {
    itemId: string;
    kind: AssetKind;
    filename: string;
    mime: string;
    bytes: number;
    sha256: string;
  }) {
    this.calls.push({ tool: "content.upload_asset", input });
    for (const stored of this.assets.values()) {
      if (
        stored.asset.kind === input.kind &&
        stored.asset.sha256 === input.sha256 &&
        stored.asset.status === "ready"
      ) {
        return { asset: summary(stored.asset), upload: null };
      }
    }
    const id = randomUUID();
    const asset: AssetDetail = {
      id,
      projectId: ids.project,
      itemId: input.itemId,
      kind: input.kind,
      status: "pending",
      filename: input.filename,
      mime: input.mime,
      bytes: input.bytes,
      sha256: input.sha256,
      width: null,
      height: null,
      durationMs: null,
      probe: null,
      createdAt: "2026-10-13T08:00:00.000Z",
      finalizedAt: null,
      alignment: null,
    };
    this.assets.set(id, { asset });
    return {
      asset: summary(asset),
      upload: {
        url: `${STORE_URL}/${id}`,
        method: "PUT" as const,
        headers: {
          "Content-Type": input.mime,
          "Content-Length": String(input.bytes),
          "x-amz-checksum-sha256": Buffer.from(input.sha256, "hex").toString("base64"),
        },
        expiresAt: "2026-10-13T09:00:00.000Z",
      },
    };
  }

  /** Called by the fake store when bytes are PUT. */
  receive(id: string, bytes: Buffer): void {
    const stored = this.assets.get(id);
    if (stored !== undefined) {
      stored.bytes = bytes;
    }
  }

  async finalizeAsset(input: {
    assetId: string;
    probe?: AssetDetail["probe"];
    alignment?: VoiceAlignment;
  }) {
    this.calls.push({ tool: "content.finalize_asset", input });
    const stored = this.assets.get(input.assetId);
    if (stored === undefined) {
      throw new PlatformError("content.finalize_asset", "not_found", "No asset has that id.");
    }
    if (this.missingOnFinalize > 0) {
      this.missingOnFinalize -= 1;
      stored.bytes = undefined;
      throw new PlatformError("content.finalize_asset", "upload_missing", "The upload is missing.");
    }
    if (stored.bytes === undefined) {
      throw new PlatformError("content.finalize_asset", "upload_missing", "The upload is missing.");
    }
    const sha256 = createHash("sha256").update(stored.bytes).digest("hex");
    const ok = sha256 === stored.asset.sha256 && stored.bytes.length === stored.asset.bytes;
    stored.asset = {
      ...stored.asset,
      status: ok ? "ready" : "failed",
      probe: input.probe ?? null,
      durationMs: input.probe?.durationMs ?? null,
      width: input.probe?.width ?? null,
      height: input.probe?.height ?? null,
      alignment: input.alignment ?? null,
      finalizedAt: "2026-10-13T08:01:00.000Z",
    };
    return { asset: summary(stored.asset) };
  }

  async getAssetUrl(input: { assetId: string }) {
    this.calls.push({ tool: "asset.get_url", input });
    const stored = this.assets.get(input.assetId);
    if (stored === undefined) {
      throw new PlatformError("asset.get_url", "not_found", "No asset has that id.");
    }
    return {
      url: `${STORE_URL}/${input.assetId}`,
      expiresAt: "2026-10-13T09:00:00.000Z",
      asset: structuredClone(stored.asset),
    };
  }

  async pullSkills(input: { name?: string }) {
    this.calls.push({ tool: "skill.pull", input });
    return {
      skills: this.skills.filter((skill) => input.name === undefined || skill.name === input.name),
    };
  }

  async close(): Promise<void> {
    this.closed += 1;
  }

  /** Adds a ready asset with the given bytes, as if uploaded earlier. */
  addReadyAsset(
    id: string,
    kind: AssetKind,
    bytes: Buffer,
    extra: Partial<AssetDetail> = {},
  ): void {
    this.assets.set(id, {
      bytes,
      asset: {
        id,
        projectId: ids.project,
        itemId,
        kind,
        status: "ready",
        filename: `${kind}.bin`,
        mime: kind === "voice" ? "audio/mpeg" : "video/mp4",
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        width: null,
        height: null,
        durationMs: null,
        probe: null,
        createdAt: "2026-10-13T08:00:00.000Z",
        finalizedAt: "2026-10-13T08:00:00.000Z",
        alignment: null,
        ...extra,
      },
    });
  }

  toolCalls(tool: string): unknown[] {
    return this.calls.filter((call) => call.tool === tool).map((call) => call.input);
  }
}

function summary(asset: AssetDetail): Asset {
  const { alignment: _alignment, ...rest } = asset;
  return structuredClone(rest);
}

export interface StoreRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly duplex?: string;
  readonly bytes: number;
}

/**
 * A fetch that plays the object store: PUTs to `STORE_URL/<id>` are stored on the platform, GETs
 * return the stored bytes. `failures` answers the next PUTs with these statuses (0 = network
 * error) before succeeding.
 */
export function fakeStore(platform: FakePlatform, failures: number[] = []) {
  const requests: StoreRequest[] = [];
  const pending = [...failures];
  const fetch: FetchLike = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const id = url.slice(`${STORE_URL}/`.length);
    if (method === "PUT") {
      const body = init?.body as ReadableStream<Uint8Array> | undefined;
      const chunks: Buffer[] = [];
      if (body !== undefined) {
        for await (const chunk of body) {
          chunks.push(Buffer.from(chunk));
        }
      }
      const bytes = Buffer.concat(chunks);
      requests.push({
        method,
        url,
        headers,
        duplex: (init as { duplex?: string } | undefined)?.duplex,
        bytes: bytes.length,
      });
      const failure = pending.shift();
      if (failure === 0) {
        throw new TypeError("fetch failed");
      }
      if (failure !== undefined) {
        return new Response("failure", { status: failure });
      }
      platform.receive(id, bytes);
      return new Response(null, { status: 200 });
    }
    requests.push({ method, url, headers, bytes: 0 });
    const stored = platform.assets.get(id);
    if (stored?.bytes === undefined) {
      return new Response("missing", { status: 404 });
    }
    return new Response(new Uint8Array(stored.bytes), { status: 200 });
  };
  return { fetch, requests };
}

/** What the fake studio records and how it behaves. */
export interface FakeStudio extends StudioRuntime {
  readonly synthesized: SynthesizeVoiceOptions[];
  readonly rendered: RenderItemOptions[];
  readonly transcribed: TranscribeOptions[];
  /** Bytes written as the voice take. */
  voiceBytes: Buffer;
  toolsReady: boolean;
  transcript: string;
  renderError?: Error;
}

/** A studio runtime that writes small files and never renders, synthesizes or transcribes. */
export function fakeStudio(root: string, bundled: BundledSkill[] = []): FakeStudio {
  const hyperframesBin = join(root, "node_modules", "hyperframes", "bin", "hyperframes.mjs");
  mkdirSync(dirname(hyperframesBin), { recursive: true });
  writeFileSync(hyperframesBin, "// pinned CLI stand-in\n");
  const registry = testRegistry();
  const studio: FakeStudio = {
    studioRoot: root,
    hyperframesBin,
    synthesized: [],
    rendered: [],
    transcribed: [],
    voiceBytes: Buffer.from("fake mp3 bytes"),
    toolsReady: true,
    transcript: "A reference about build caches.",
    loadRegistry: () => registry,
    cardCatalogue: (reg, styleId) => cardCatalogue(reg, styleId),
    validateStoryboard: (sb, reg, options) => validateStoryboard(sb, reg, options),
    async synthesizeVoice(options) {
      studio.synthesized.push(options);
      for (const fraction of [0.25, 0.5, 0.75]) {
        options.onProgress?.(fraction);
      }
      mkdirSync(dirname(options.outputPath), { recursive: true });
      writeFileSync(options.outputPath, studio.voiceBytes);
      options.onProgress?.(1);
      return {
        path: options.outputPath,
        durationMs: 9_000,
        alignment,
        segments: [],
        parts: 1,
        characters: 100,
      };
    },
    async renderItem(options): Promise<RenderItemResult> {
      studio.rendered.push(options);
      if (studio.renderError !== undefined) {
        throw studio.renderError;
      }
      for (const fraction of [0, 0.05, 0.12, 0.31, 0.33, 0.58, 0.86, 0.95, 1]) {
        options.onProgress?.({ stage: fraction < 0.85 ? "render" : "encode", fraction });
      }
      const output = join(options.itemDir, "out", "final.mp4");
      const poster = join(options.itemDir, "poster.jpg");
      mkdirSync(dirname(output), { recursive: true });
      writeFileSync(output, Buffer.from("fake mp4 bytes"));
      writeFileSync(poster, Buffer.from("fake jpg bytes"));
      return {
        assembly: {
          renderDir: join(options.itemDir, "render"),
          indexPath: join(options.itemDir, "render", "index.html"),
          durationMs: 9_000,
          frames: [],
          captions: [],
          warnings: [],
        },
        render: {
          outputPath: output,
          posterPath: poster,
          durationMs: 9_010,
          width: 1080,
          height: 1920,
          sizeBytes: 14,
          lintFindings: [],
        },
      };
    },
    async probeMedia(path): Promise<MediaProbe> {
      if (path.endsWith(".jpg")) {
        return {
          durationMs: 0,
          sizeBytes: 14,
          formatName: "image2",
          video: { codec: "mjpeg", width: 1080, height: 1920, fps: 0 },
        };
      }
      if (path.endsWith(".mp4")) {
        return {
          durationMs: 9_010,
          sizeBytes: 14,
          formatName: "mov,mp4,m4a,3gp,3g2,mj2",
          video: { codec: "h264", width: 1080, height: 1920, fps: 30 },
          audio: { codec: "aac", sampleRate: 48_000, channels: 2, bitRate: 128_000 },
        };
      }
      return {
        durationMs: 9_000,
        sizeBytes: 14,
        formatName: "mp3",
        audio: { codec: "mp3", sampleRate: 44_100, channels: 1, bitRate: 128_000 },
      };
    },
    async transcribeMedia(options) {
      studio.transcribed.push(options);
      return { text: studio.transcript, words: [] };
    },
    async checkRenderTools() {
      return {
        ffmpeg: studio.toolsReady,
        ffprobe: true,
        hyperframes: true,
        gsap: true,
        ready: studio.toolsReady,
        ...(studio.toolsReady ? { browser: "/fake/headless-shell" } : {}),
      };
    },
    loadBundledSkills: () => bundled,
    readVoiceProviderKey: () => undefined,
  };
  return studio;
}

/** A producer runtime that records its inputs and answers with `respond`. */
export function fakeRuntime(
  respond: (input: ProducerRunInput, call: number) => string,
): ProducerRuntime & { inputs: ProducerRunInput[] } {
  const inputs: ProducerRunInput[] = [];
  return {
    inputs,
    run: async (input): Promise<ProducerRunResult> => {
      inputs.push(input);
      input.onEvent({ kind: "session", data: { sessionId: SESSION_ID } });
      input.onEvent({ kind: "status", data: { state: "running" } });
      input.onEvent({ kind: "tool.activity", data: { tool: "Read", summary: "script.json" } });
      input.onEvent({ kind: "assistant.message", data: { text: "not a conversation reply" } });
      input.onEvent({ kind: "usage", data: { outputTokens: 10 } });
      return {
        sessionId: SESSION_ID,
        finalText: respond(input, inputs.length),
        numTurns: 1,
        durationMs: 10,
      };
    },
  };
}

/** A fenced JSON reply. */
export function jsonReply(value: unknown, after = ""): string {
  return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\`\n${after}`;
}

export interface RecordedEvent {
  readonly kind: JobEventKind;
  readonly data: unknown;
}

/** A job context for a production handler; emitted events are recorded. */
export function jobContext<T extends JobType>(
  type: T,
  payload: JobPayload<T>,
  options: { credentials?: HandlerCredentials; signal?: AbortSignal } = {},
): { ctx: JobContext<T>; events: RecordedEvent[]; credentials: McpCredentials } {
  const events: RecordedEvent[] = [];
  const credentials = createMcpCredentials(
    new URL("/mcp", "http://127.0.0.1:8790"),
    testJobToken(),
    new Date(Date.now() + 600_000).toISOString(),
  );
  const ctx: JobContext<T> = {
    job: {
      id: ids.job,
      type,
      projectId: ids.project,
      attempt: 1,
      payload,
    } as JobContext<T>["job"],
    credentials: options.credentials ?? { mcp: credentials },
    emit: <K extends JobEventKind>(kind: K, data: JobEventData<K>) => {
      events.push({ kind, data });
    },
    stream: () => {},
    signal: options.signal ?? new AbortController().signal,
    log: silentLogger,
  };
  return { ctx, events, credentials };
}

/** Production dependencies around the fakes. */
export function productionDeps(options: {
  workspaceRoot: string;
  platform: FakePlatform;
  studio: FakeStudio;
  runtime?: ProducerRuntime;
  voiceKey?: string;
  fetch?: FetchLike;
}): ProducerStepDeps & { connects: McpCredentials[] } {
  const connects: McpCredentials[] = [];
  return {
    connects,
    workspaceRoot: options.workspaceRoot,
    connect: async (credentials) => {
      connects.push(credentials);
      return options.platform;
    },
    studio: async () => options.studio,
    voiceKey: async () => options.voiceKey,
    runtime: options.runtime ?? fakeRuntime(() => ""),
    fetch: options.fetch,
    sleep: async () => {},
    log: silentLogger,
  };
}

/** A pulled skill with a correct checksum. */
export function pulledSkill(
  name: string,
  version: number,
  files: { path: string; content: string }[],
): PulledSkill {
  return { name, kind: "skill", version, checksum: skillChecksum(files), files };
}
