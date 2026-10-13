import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type AssetMimeType,
  type KbAnalyzeReferenceResult,
  MAX_ANALYSIS_SUMMARY_LENGTH,
  MAX_TRANSCRIPT_LENGTH,
  parseJobPayload,
  type ReferenceAnalysis,
  ReferenceAnalysisSchema,
  TranscriptSchema,
} from "@loomcast/contracts";
import type { z } from "zod";
import { type Handler, type JobContext, JobFailure } from "../handlers";
import {
  ANALYSIS_BRIEF,
  analysisPrompt,
  repairPrompt,
} from "../producer/prompts/analyze-reference";
import type { ProducerEvent, ProducerRunResult, ProducerRuntime } from "../producer/runtime";
import { ensureProjectWorkspace } from "../producer/workspace";
import { type ProductionDeps, toJobFailure, withPlatform } from "../production/context";
import { productionDeps } from "../production/deps";
import { downloadFile } from "../production/upload";
import type { HandlerDeps } from "./index";

/** What transcribing uploaded reference media needs. */
export type ReferenceMediaDeps = Pick<
  ProductionDeps,
  "connect" | "studio" | "voiceKey" | "fetch" | "sleep"
>;

export interface AnalyzeReferenceOptions {
  readonly runtime: ProducerRuntime;
  /** Transcripts are written below `<workspaceRoot>/projects/<projectId>/references/`. */
  readonly workspaceRoot: string;
  /** Without it, a reference with media but no transcript fails as `transcript_required`. */
  readonly media?: ReferenceMediaDeps;
}

/** The `kb.analyze_reference` handler of a running agent. */
export function createKbAnalyzeReferenceHandler(
  deps: HandlerDeps,
): Handler<"kb.analyze_reference"> {
  const production = productionDeps(deps);
  return analyzeReferenceHandler({
    runtime: production.runtime,
    workspaceRoot: deps.config.workspaceRoot,
    media: production,
  });
}

/**
 * `kb.analyze_reference`: analyses a saved reference from its transcript in a new, read-only
 * producer session.
 *
 * - A payload without a transcript but with uploaded media (`mediaAssetId`) is transcribed first:
 *   the media is downloaded from the platform's own storage through `asset.get_url` (checked
 *   against its SHA-256), its audio is extracted and transcribed with the TTS provider's
 *   speech-to-text, and the media file is removed again. The result then carries the transcript.
 * - The transcript is written to `<workspace>/references/<entryId>/transcript.txt` and sent inside
 *   an untrusted-data block. The reference URL is never fetched and never shown to the session.
 * - The first fenced JSON block of the reply is validated against `ReferenceAnalysis`. When it
 *   does not validate, one repair turn in the same session gets the problems; a second failure
 *   fails the job.
 */
export function analyzeReferenceHandler(
  options: AnalyzeReferenceOptions,
): Handler<"kb.analyze_reference"> {
  return async (ctx): Promise<KbAnalyzeReferenceResult> => {
    const parsed = parseJobPayload("kb.analyze_reference", ctx.job.payload);
    if (!parsed.success) {
      throw new JobFailure("invalid_payload", "The kb.analyze_reference payload is invalid");
    }
    const payload = parsed.data;
    if (payload.projectId !== ctx.job.projectId) {
      throw new JobFailure("invalid_payload", "The payload's project does not match the job's");
    }
    if (payload.transcript === undefined && options.media === undefined) {
      throw new JobFailure(
        "transcript_required",
        "This studio agent can only analyse a reference from its transcript; add a transcript",
        false,
      );
    }

    ctx.emit("status", { state: "starting" });
    const workspace = await ensureProjectWorkspace(options.workspaceRoot, payload.projectId);
    const referenceDir = join(workspace.dir, "references", payload.entryId);
    await mkdir(referenceDir, { recursive: true });
    let transcript = payload.transcript;
    let transcribed = false;
    if (transcript === undefined) {
      if (options.media === undefined || payload.mediaAssetId === undefined) {
        throw new JobFailure("transcript_required", "The reference has no transcript", false);
      }
      ctx.emit("status", { state: "transcribing" });
      try {
        transcript = await transcribeReferenceMedia(ctx, options.media, {
          projectId: payload.projectId,
          mediaAssetId: payload.mediaAssetId,
          referenceDir,
        });
      } catch (error) {
        throw toJobFailure(error, "transcription_failed");
      }
      transcribed = true;
    }
    const transcriptPath = join(referenceDir, "transcript.txt");
    await writeFile(transcriptPath, transcript, "utf8");

    const events = new SessionEvents(ctx);
    const run = (prompt: string, resumeId?: string): Promise<ProducerRunResult> =>
      options.runtime.run({
        prompt,
        resumeId,
        cwd: workspace.dir,
        signal: ctx.signal,
        jobType: "kb.analyze_reference",
        mcp: ctx.credentials.mcp,
        brief: ANALYSIS_BRIEF,
        onEvent: (event) => events.emit(event),
        // The reply is JSON for the server, not text for a conversation.
        onDelta: () => {},
      });

    const first = await run(analysisPrompt({ payload, transcript, transcriptPath }));
    let reply = readAnalysisReply(first.finalText);
    let turns = first.numTurns;
    if (!reply.ok) {
      ctx.log.warn("analysis reply did not validate; asking for a repair", {
        problems: reply.problems.length,
      });
      ctx.emit("status", {
        state: "repairing",
        message: truncate(`The analysis did not validate: ${reply.problems.join("; ")}`, 1_000),
      });
      const repaired = await run(repairPrompt(reply.problems), first.sessionId);
      turns += repaired.numTurns;
      reply = readAnalysisReply(repaired.finalText);
      if (!reply.ok) {
        throw new JobFailure(
          "analysis_invalid",
          truncate(
            `The producer session did not return a valid analysis: ${reply.problems.join("; ")}`,
            2_000,
          ),
          false,
        );
      }
    }
    ctx.log.info("reference analysis finished", { numTurns: turns, transcribed });
    return {
      analysis: reply.analysis,
      summaryMd: reply.summaryMd,
      ...(transcribed ? { transcript } : {}),
    };
  };
}

/** File extensions for reference media, so the transcriber knows audio from video. */
const MEDIA_EXTENSIONS: Partial<Record<AssetMimeType, string>> = {
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "audio/mpeg": ".mp3",
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
  "audio/mp4": ".m4a",
  "audio/x-m4a": ".m4a",
};

/**
 * Downloads the reference's uploaded media, transcribes it and returns the transcript, cut to the
 * contract's limits. The media is removed afterwards; the transcript is kept next to it.
 */
async function transcribeReferenceMedia(
  ctx: JobContext<"kb.analyze_reference">,
  media: ReferenceMediaDeps,
  target: {
    readonly projectId: string;
    readonly mediaAssetId: string;
    readonly referenceDir: string;
  },
): Promise<string> {
  const { referenceDir } = target;
  const apiKey = await media.voiceKey();
  if (apiKey === undefined || apiKey.length === 0) {
    throw new JobFailure(
      "voice_provider_key_missing",
      "No TTS provider key is set on this Mac to transcribe the media; run `studio-agent secrets set voice-provider-key`",
      false,
    );
  }
  const mediaPath = await withPlatform(ctx, media.connect, async (platform) => {
    const { url, asset } = await platform.getAssetUrl({ assetId: target.mediaAssetId });
    if (
      asset.kind !== "reference_media" ||
      asset.status !== "ready" ||
      asset.projectId !== target.projectId
    ) {
      throw new JobFailure(
        "invalid_payload",
        "The media is not ready reference media of this project",
      );
    }
    const extension = MEDIA_EXTENSIONS[asset.mime as AssetMimeType] ?? ".mp4";
    const path = join(referenceDir, `media${extension}`);
    await downloadFile({
      url,
      path,
      sha256: asset.sha256,
      signal: ctx.signal,
      fetch: media.fetch,
      sleep: media.sleep,
    });
    return path;
  });
  try {
    const studio = await media.studio();
    const result = await studio.transcribeMedia({
      apiKey,
      inputPath: mediaPath,
      signal: ctx.signal,
    });
    const text = cleanTranscript(result.text);
    const parsed = TranscriptSchema.safeParse(text);
    if (!parsed.success) {
      throw new JobFailure("transcript_empty", "The media has no speech to transcribe", false);
    }
    return parsed.data;
  } finally {
    await rm(mediaPath, { force: true });
  }
}

/** Removes control characters (other than line breaks and tabs) and cuts to the contract's limit. */
export function cleanTranscript(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it strips
  const plain = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").trim();
  if (plain.length <= MAX_TRANSCRIPT_LENGTH) {
    return plain;
  }
  // Never end on half a surrogate pair.
  return plain
    .slice(0, MAX_TRANSCRIPT_LENGTH)
    .replace(/[\uD800-\uDBFF]$/, "")
    .trim();
}

/** Records a session's durable events; the session id is reported once across both turns. */
class SessionEvents {
  readonly #ctx: JobContext<"kb.analyze_reference">;
  #sessionId: string | undefined;

  constructor(ctx: JobContext<"kb.analyze_reference">) {
    this.#ctx = ctx;
  }

  emit(event: ProducerEvent): void {
    switch (event.kind) {
      case "session":
        if (this.#sessionId !== event.data.sessionId) {
          this.#sessionId = event.data.sessionId;
          this.#ctx.emit("session", event.data);
        }
        return;
      case "status":
        this.#ctx.emit("status", event.data);
        return;
      case "tool.activity":
        this.#ctx.emit("tool.activity", event.data);
        return;
      case "usage":
        this.#ctx.emit("usage", event.data);
        return;
      case "assistant.message":
        // The reply is the result; it is not a conversation message.
        return;
    }
  }
}

export type AnalysisReply =
  | { readonly ok: true; readonly analysis: ReferenceAnalysis; readonly summaryMd: string }
  | { readonly ok: false; readonly problems: string[] };

const FENCE = /```[ \t]*([A-Za-z0-9_-]*)[^\n]*\n([\s\S]*?)```/g;

/** The first fenced code block marked `json` (or unmarked), and the reply without it. */
export function extractJsonBlock(text: string): { json: string; rest: string } | null {
  for (const match of text.matchAll(FENCE)) {
    const language = match[1]?.toLowerCase() ?? "";
    if (language === "json" || language === "") {
      const start = match.index ?? 0;
      return {
        json: match[2] ?? "",
        rest: `${text.slice(0, start)}${text.slice(start + match[0].length)}`,
      };
    }
  }
  return null;
}

/** Validates a reply: its first JSON block against `ReferenceAnalysis`, plus the summary. */
export function readAnalysisReply(text: string): AnalysisReply {
  const block = extractJsonBlock(text);
  if (block === null) {
    return { ok: false, problems: ["The reply has no fenced ```json code block."] };
  }
  let value: unknown;
  try {
    value = JSON.parse(block.json);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, problems: [`The JSON block is not valid JSON: ${truncate(reason, 300)}`] };
  }
  const analysis = ReferenceAnalysisSchema.safeParse(value);
  if (!analysis.success) {
    return { ok: false, problems: describeIssues(analysis.error.issues) };
  }
  return { ok: true, analysis: analysis.data, summaryMd: summaryOf(block.rest, analysis.data) };
}

/** The model's summary, or one built from the analysis when the reply has none. */
function summaryOf(rest: string, analysis: ReferenceAnalysis): string {
  const written = rest.trim();
  if (written.length > 0) {
    return truncate(written, MAX_ANALYSIS_SUMMARY_LENGTH);
  }
  const lines = [
    `**Hook (${analysis.hook.type}):** ${analysis.hook.text}`,
    "",
    ...analysis.takeaways.map((takeaway) => `- ${takeaway}`),
  ];
  return truncate(lines.join("\n"), MAX_ANALYSIS_SUMMARY_LENGTH);
}

function describeIssues(issues: readonly z.core.$ZodIssue[]): string[] {
  const described = issues
    .slice(0, 20)
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${truncate(issue.message, 200)}`);
  if (issues.length > described.length) {
    described.push(`…and ${issues.length - described.length} more problems`);
  }
  return described;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
