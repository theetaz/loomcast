import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type AssetMimeType,
  isPublicVideoUrl,
  type JobType,
  type KbAnalyzeReferencePayload,
  type KbAnalyzeReferenceResult,
  MAX_ANALYSIS_SUMMARY_LENGTH,
  MAX_TRANSCRIPT_LENGTH,
  parseJobPayload,
  type ReferenceAnalysis,
  ReferenceAnalysisSchema,
  type ReferenceMediaFacts,
  TranscriptSchema,
} from "@loomcast/contracts";
import type { z } from "zod";
import { type Handler, type JobContext, JobFailure } from "../handlers";
import { ensurePrivateDir } from "../private-fs";
import {
  ANALYSIS_BRIEF,
  analysisPrompt,
  type MeasuredMedia,
  repairPrompt,
} from "../producer/prompts/analyze-reference";
import type { ProducerEvent, ProducerRunResult, ProducerRuntime } from "../producer/runtime";
import { ensureProjectWorkspace } from "../producer/workspace";
import { type ProductionDeps, toJobFailure, withPlatform } from "../production/context";
import { productionDeps } from "../production/deps";
import { downloadFile } from "../production/upload";
import {
  createPublicVideoTools,
  MAX_VIDEO_BYTES,
  MAX_VIDEO_DURATION_MS,
  type PublicVideoTools,
} from "../research/public-video";
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
  /** Downloads and measures public videos; without it `fetchPublicVideo` fails. */
  readonly publicVideo?: PublicVideoTools;
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
    publicVideo: createPublicVideoTools({ ytDlpPath: deps.config.ytDlpPath }),
  });
}

/** A transcript and the measured facts of a downloaded video, ready for the session. */
interface FetchedVideo {
  readonly transcript: string | undefined;
  readonly media: MeasuredMedia;
}

/**
 * `kb.analyze_reference`: analyses a saved reference in a new, read-only producer session, from
 * the first source the payload has: its transcript, uploaded media, or the public video at its URL.
 *
 * - A payload without a transcript but with uploaded media (`mediaAssetId`) is transcribed first:
 *   the media is downloaded from the platform's own storage through `asset.get_url` (checked
 *   against its SHA-256), its audio is extracted and transcribed with the TTS provider's
 *   speech-to-text, and the media file is removed again. The result then carries the transcript.
 * - A payload with only `fetchPublicVideo` has its link checked again with `isPublicVideoUrl`; the
 *   video is downloaded with `yt-dlp` into `references/<entryId>/media-<jobId>/`, checked and
 *   measured with ffprobe and ffmpeg (duration, cuts, six frames) and transcribed. The session gets
 *   the measured facts and the frame paths, and the result carries them as `media`. A video without
 *   speech is analysed without a transcript. The video and the frames are deleted afterwards,
 *   whatever the outcome.
 * - The transcript is written to `<workspace>/references/<entryId>/transcript.txt` and sent inside
 *   an untrusted-data block. The session never sees the reference URL and cannot fetch anything.
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
    const fetches =
      payload.transcript === undefined &&
      payload.mediaAssetId === undefined &&
      payload.fetchPublicVideo === true;
    if (fetches && !isFetchableLink(payload)) {
      throw new JobFailure(
        "invalid_payload",
        "Only a public video link of the platform is fetched",
      );
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
    const transcriptPath = join(referenceDir, "transcript.txt");
    const analyse = (transcript: string | undefined, media?: MeasuredMedia) =>
      runAnalysis(ctx, options.runtime, workspace.dir, payload, {
        transcript,
        transcriptPath: transcript === undefined ? undefined : transcriptPath,
        media,
      });

    if (fetches) {
      const media = options.media;
      const tools = options.publicVideo;
      if (media === undefined || tools === undefined) {
        throw new JobFailure(
          "downloader_missing",
          "This studio agent cannot download public videos; install yt-dlp",
          false,
        );
      }
      const apiKey = await requireVoiceKey(media);
      const jobDir = join(referenceDir, `media-${ctx.job.id}`);
      await rm(jobDir, { recursive: true, force: true });
      ensurePrivateDir(jobDir);
      try {
        const fetched = await fetchAndMeasure(ctx, tools, media, apiKey, payload.url, jobDir);
        if (fetched.transcript !== undefined) {
          await writeFile(transcriptPath, fetched.transcript, "utf8");
        }
        const reply = await analyse(fetched.transcript, fetched.media);
        const facts: ReferenceMediaFacts = {
          durationMs: fetched.media.durationMs,
          cutsPerMinute: fetched.media.cutsPerMinute,
          wordsPerMinute: fetched.media.wordsPerMinute,
          framesSeen: fetched.media.framePaths.length,
        };
        return {
          ...reply,
          ...(fetched.transcript === undefined ? {} : { transcript: fetched.transcript }),
          media: facts,
        };
      } finally {
        // The video and its frames never outlive the job; only transcript.txt stays.
        await rm(jobDir, { recursive: true, force: true });
      }
    }

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
    await writeFile(transcriptPath, transcript, "utf8");
    const reply = await analyse(transcript);
    return { ...reply, ...(transcribed ? { transcript } : {}) };
  };
}

/** Whether the payload's link may be downloaded: a public video link of a competitor platform. */
function isFetchableLink(payload: KbAnalyzeReferencePayload): boolean {
  const { platform } = payload;
  return (
    (platform === "instagram" || platform === "facebook" || platform === "threads") &&
    isPublicVideoUrl(payload.url, platform)
  );
}

/** Runs the analysis session, with one repair turn, and returns the validated reply. */
async function runAnalysis(
  ctx: JobContext<"kb.analyze_reference">,
  runtime: ProducerRuntime,
  cwd: string,
  payload: KbAnalyzeReferencePayload,
  input: { transcript?: string; transcriptPath?: string; media?: MeasuredMedia },
): Promise<{ analysis: ReferenceAnalysis; summaryMd: string }> {
  const events = new SessionEvents(ctx);
  const run = (prompt: string, resumeId?: string): Promise<ProducerRunResult> =>
    runtime.run({
      prompt,
      resumeId,
      cwd,
      signal: ctx.signal,
      jobType: "kb.analyze_reference",
      mcp: ctx.credentials.mcp,
      brief: ANALYSIS_BRIEF,
      onEvent: (event) => events.emit(event),
      // The reply is JSON for the server, not text for a conversation.
      onDelta: () => {},
    });

  const first = await run(analysisPrompt({ payload, ...input }));
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
  ctx.log.info("reference analysis finished", {
    numTurns: turns,
    transcript: input.transcript !== undefined,
    frames: input.media?.framePaths.length ?? 0,
  });
  return { analysis: reply.analysis, summaryMd: reply.summaryMd };
}

/** The TTS provider key, or the same failure as any transcription without one. */
async function requireVoiceKey(media: ReferenceMediaDeps): Promise<string> {
  const apiKey = await media.voiceKey();
  if (apiKey === undefined || apiKey.length === 0) {
    throw new JobFailure(
      "voice_provider_key_missing",
      "No TTS provider key is set on this Mac to transcribe the media; run `studio-agent secrets set voice-provider-key`",
      false,
    );
  }
  return apiKey;
}

/**
 * Downloads the public video into `jobDir`, checks it, measures it and transcribes it. The caller
 * deletes `jobDir` afterwards.
 */
async function fetchAndMeasure(
  ctx: JobContext<"kb.analyze_reference">,
  tools: PublicVideoTools,
  media: ReferenceMediaDeps,
  apiKey: string,
  url: string,
  jobDir: string,
): Promise<FetchedVideo> {
  const { signal } = ctx;
  ctx.emit("status", { state: "downloading" });
  const videoPath = await tools.download({ url, dir: jobDir, signal });

  ctx.emit("status", { state: "measuring" });
  const probe = await tools.probe(videoPath, signal);
  const sizeBytes = Math.max(probe.sizeBytes, (await stat(videoPath)).size);
  if (sizeBytes > MAX_VIDEO_BYTES) {
    throw new JobFailure("video_too_large", "The video is larger than 300 MB", false);
  }
  if (probe.durationMs > MAX_VIDEO_DURATION_MS) {
    throw new JobFailure("video_too_long", "The video is longer than 10 minutes", false);
  }
  if (!probe.hasVideo || probe.durationMs === 0) {
    throw new JobFailure("video_invalid", "The download is not a playable video", false);
  }
  const minutes = probe.durationMs / 60_000;
  const cuts = await optionalMeasure(ctx, "scene detection", () =>
    tools.countCuts(videoPath, signal),
  );
  const framePaths =
    (await optionalMeasure(ctx, "frame extraction", () =>
      tools.extractFrames({
        path: videoPath,
        dir: join(jobDir, "frames"),
        durationMs: probe.durationMs,
        signal,
      }),
    )) ?? [];

  let transcript: string | undefined;
  if (probe.hasAudio) {
    ctx.emit("status", { state: "transcribing" });
    try {
      const studio = await media.studio();
      const result = await studio.transcribeMedia({ apiKey, inputPath: videoPath, signal });
      const parsed = TranscriptSchema.safeParse(cleanTranscript(result.text));
      // A video without speech is analysed from its frames alone.
      transcript = parsed.success ? parsed.data : undefined;
    } catch (error) {
      throw toJobFailure(error, "transcription_failed");
    }
  }
  const words = transcript === undefined ? 0 : transcript.split(/\s+/).filter(Boolean).length;
  return {
    transcript,
    media: {
      durationMs: probe.durationMs,
      cutsPerMinute: cuts === undefined ? null : perMinute(cuts, minutes, 600),
      wordsPerMinute: perMinute(words, minutes, 1_000),
      framePaths,
    },
  };
}

/**
 * Runs a measurement whose failure only leaves a number out. An abort, or a missing tool, still
 * fails the job.
 */
async function optionalMeasure<T>(
  ctx: JobContext<"kb.analyze_reference">,
  label: string,
  measure: () => Promise<T>,
): Promise<T | undefined> {
  try {
    return await measure();
  } catch (error) {
    if (
      ctx.signal.aborted ||
      (error instanceof JobFailure && error.code === "media_tools_missing")
    ) {
      throw error;
    }
    ctx.log.warn(`${label} failed; analysing without it`, {
      error: error instanceof Error ? truncate(error.message, 300) : String(error),
    });
    return undefined;
  }
}

/** `count` per minute, rounded to one decimal and capped at the contract's maximum. */
function perMinute(count: number, minutes: number, max: number): number {
  return Math.min(Math.round((count / minutes) * 10) / 10, max);
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
  const apiKey = await requireVoiceKey(media);
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

/**
 * Records a read-only session's durable events; the session id is reported once across both
 * turns, and the reply is not recorded as a conversation message.
 */
export class SessionEvents {
  readonly #ctx: Pick<JobContext<JobType>, "emit">;
  #sessionId: string | undefined;

  constructor(ctx: Pick<JobContext<JobType>, "emit">) {
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

/** Schema problems as `path: message` lines, at most 20 of them. */
export function describeIssues(issues: readonly z.core.$ZodIssue[]): string[] {
  const described = issues
    .slice(0, 20)
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${truncate(issue.message, 200)}`);
  if (issues.length > described.length) {
    described.push(`…and ${issues.length - described.length} more problems`);
  }
  return described;
}

/** Cuts `text` to `max` characters, ending with an ellipsis when cut. */
export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
