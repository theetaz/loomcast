import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { SHORT_FPS, SHORT_HEIGHT, SHORT_WIDTH } from "./assemble.ts";
import { studioPaths } from "./paths.ts";
import { type MediaProbe, probeMedia } from "./probe.ts";
import { CommandError, type CommandRunner, runChecked, runCommand } from "./process.ts";

// Renders an assembled project: HyperFrames lint, HyperFrames render (headless Chrome), then an
// ffmpeg pass that guarantees the delivery format (H.264 High, yuv420p, 30 fps, AAC 48 kHz
// 128k, loudness normalised to -14 LUFS, faststart), a poster frame and an ffprobe check.
//
// The CLI is the studio's pinned HyperFrames, started with node directly: `npx hyperframes`
// from a render folder outside the studio would resolve (or download) a different copy.

export type RenderQuality = "draft" | "standard" | "high";
export type RenderStage = "lint" | "render" | "encode" | "poster" | "verify" | "done";

export interface RenderProgress {
  stage: RenderStage;
  /** Overall progress, 0 to 1. */
  fraction: number;
}

export interface LintFinding {
  code: string;
  severity: "error" | "warning" | "info";
  message: string;
  file?: string;
}

export interface RenderOptions {
  /** The assembled HyperFrames project. */
  renderDir: string;
  /** The delivered MP4. */
  outputPath: string;
  /** The poster JPEG, taken at 1 s. */
  posterPath: string;
  /** The voice take; defaults to the project's `assets/voice.mp3`. */
  voicePath?: string;
  /** The length the video must have (±0.5 s); defaults to the voice take's length. */
  expectedDurationMs?: number;
  quality?: RenderQuality;
  /** Render workers; defaults to the CLI's own choice. */
  workers?: number;
  /** A Chrome or headless-shell binary; otherwise the CLI uses its browser cache. */
  browserPath?: string;
  /** Integrated loudness target in LUFS. */
  loudnessLufs?: number;
  studioRoot?: string;
  nodePath?: string;
  ffmpegPath?: string;
  ffprobePath?: string;
  run?: CommandRunner;
  signal?: AbortSignal;
  onProgress?: (progress: RenderProgress) => void;
}

export interface RenderResult {
  outputPath: string;
  posterPath: string;
  durationMs: number;
  width: number;
  height: number;
  sizeBytes: number;
  lintFindings: LintFinding[];
}

export const DURATION_TOLERANCE_MS = 500;
export const POSTER_AT_SECONDS = 1;

/** Overall progress at the start of each stage. */
const STAGE_START: Record<RenderStage, number> = {
  lint: 0,
  render: 0.05,
  encode: 0.85,
  poster: 0.95,
  verify: 0.97,
  done: 1,
};

export class RenderLintError extends Error {
  readonly findings: LintFinding[];

  constructor(findings: LintFinding[]) {
    const errors = findings.filter((finding) => finding.severity === "error");
    super(
      `The composition failed lint: ${errors.map((f) => `${f.code}: ${f.message}`).join("; ")}`,
    );
    this.name = "RenderLintError";
    this.findings = findings;
  }
}

export class RenderVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RenderVerificationError";
  }
}

export interface CliCommand {
  command: string;
  args: string[];
  env: Record<string, string>;
}

function cliEnv(options: Pick<RenderOptions, "browserPath">): Record<string, string> {
  return options.browserPath ? { HYPERFRAMES_BROWSER_PATH: options.browserPath } : {};
}

/** `hyperframes lint <dir> --json`. */
export function lintCommand(options: RenderOptions): CliCommand {
  const paths = studioPaths(options.studioRoot);
  return {
    command: options.nodePath ?? process.execPath,
    args: [paths.hyperframesBin, "lint", options.renderDir, "--json"],
    env: cliEnv(options),
  };
}

/** `hyperframes render <dir> --output <raw> --fps 30 --quality <q> [--workers <n>]`. */
export function renderCommand(options: RenderOptions, rawPath: string): CliCommand {
  const paths = studioPaths(options.studioRoot);
  const args = [
    paths.hyperframesBin,
    "render",
    options.renderDir,
    "--output",
    rawPath,
    "--fps",
    String(SHORT_FPS),
    "--quality",
    options.quality ?? "standard",
    "--format",
    "mp4",
  ];
  if (options.workers !== undefined) args.push("--workers", String(options.workers));
  return { command: options.nodePath ?? process.execPath, args, env: cliEnv(options) };
}

/** The ffmpeg delivery encode; `voicePath` is muxed only when the raw render has no audio. */
export function encodeArgs(input: {
  rawPath: string;
  outputPath: string;
  voicePath?: string;
  loudnessLufs?: number;
  /** Trims the output to the video's length (audio encoders pad a few frames). */
  durationMs?: number;
}): string[] {
  const lufs = input.loudnessLufs ?? -14;
  const args = ["-y", "-v", "error", "-i", input.rawPath];
  if (input.voicePath) args.push("-i", input.voicePath);
  args.push(
    "-map",
    "0:v:0",
    "-map",
    input.voicePath ? "1:a:0" : "0:a:0",
    "-af",
    `loudnorm=I=${lufs}:TP=-1.5:LRA=11`,
    "-c:v",
    "libx264",
    "-profile:v",
    "high",
    "-pix_fmt",
    "yuv420p",
    "-r",
    String(SHORT_FPS),
    "-preset",
    "medium",
    "-crf",
    "20",
    "-c:a",
    "aac",
    "-ar",
    "48000",
    "-b:a",
    "128k",
    "-movflags",
    "+faststart",
  );
  if (input.durationMs !== undefined) args.push("-t", (input.durationMs / 1000).toFixed(3));
  args.push(input.outputPath);
  return args;
}

/** The poster: one JPEG frame at `atSeconds`. */
export function posterArgs(videoPath: string, posterPath: string, atSeconds: number): string[] {
  return [
    "-y",
    "-v",
    "error",
    "-ss",
    String(atSeconds),
    "-i",
    videoPath,
    "-frames:v",
    "1",
    "-q:v",
    "2",
    posterPath,
  ];
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI colour codes from CLI output
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;

/** Reads the CLI's render progress (0 to 1) from a chunk of its output, if it reports any. */
export function parseRenderProgress(chunk: string): number | undefined {
  const text = chunk.replace(ANSI, "");
  let latest: number | undefined;
  for (const match of text.matchAll(/(\d{1,3})%\s+(?:Capturing|Encoding|Assembling|Render)/g)) {
    latest = Math.min(Number(match[1]), 100) / 100;
  }
  if (latest === undefined) {
    for (const match of text.matchAll(
      /"framesCompleted":(\d+)[^}]*?"totalFrames":(\d+)|"totalFrames":(\d+)[^}]*?"framesCompleted":(\d+)/g,
    )) {
      const done = Number(match[1] ?? match[4]);
      const total = Number(match[2] ?? match[3]);
      if (total > 0) latest = Math.min(done / total, 1) * 0.7;
    }
  }
  return latest;
}

/** Parses `hyperframes lint --json` output. */
export function parseLint(stdout: string): LintFinding[] {
  const start = stdout.indexOf("{");
  if (start < 0) throw new Error("The lint step printed no JSON report");
  const report = JSON.parse(stdout.slice(start)) as { findings?: LintFinding[] };
  return (report.findings ?? []).map(({ code, severity, message, file }) => ({
    code,
    severity,
    message,
    ...(file ? { file } : {}),
  }));
}

/** Checks a delivered file against the delivery format. */
export function verifyDelivery(probe: MediaProbe, expectedDurationMs: number): void {
  const problems: string[] = [];
  if (probe.video?.width !== SHORT_WIDTH || probe.video?.height !== SHORT_HEIGHT) {
    problems.push(
      `expected ${SHORT_WIDTH}x${SHORT_HEIGHT}, got ${probe.video?.width ?? 0}x${probe.video?.height ?? 0}`,
    );
  }
  if (probe.video?.codec !== "h264") problems.push(`expected H.264, got ${probe.video?.codec}`);
  if (!probe.audio) problems.push("the video has no audio track");
  if (Math.abs(probe.durationMs - expectedDurationMs) > DURATION_TOLERANCE_MS) {
    problems.push(
      `expected ${(expectedDurationMs / 1000).toFixed(2)} s ±${DURATION_TOLERANCE_MS / 1000} s, got ${(probe.durationMs / 1000).toFixed(2)} s`,
    );
  }
  if (problems.length > 0) {
    throw new RenderVerificationError(`The render failed verification: ${problems.join("; ")}`);
  }
}

/** Lints, renders, encodes and verifies an assembled project. */
export async function renderProject(options: RenderOptions): Promise<RenderResult> {
  const run = options.run ?? runCommand;
  const ffmpeg = options.ffmpegPath ?? "ffmpeg";
  const probe = (path: string) =>
    probeMedia(path, { ffprobePath: options.ffprobePath, run, signal: options.signal });
  let reported = -1;
  const report = (stage: RenderStage, within = 0) => {
    const start = STAGE_START[stage];
    const end = stage === "done" ? 1 : (Object.values(STAGE_START).find((v) => v > start) ?? 1);
    const fraction =
      Math.round((start + (end - start) * Math.min(Math.max(within, 0), 1)) * 1000) / 1000;
    if (fraction <= reported) return;
    reported = fraction;
    options.onProgress?.({ stage, fraction });
  };

  const voicePath = options.voicePath ?? join(options.renderDir, "assets", "voice.mp3");
  const expectedDurationMs = options.expectedDurationMs ?? (await probe(voicePath)).durationMs;

  report("lint");
  const lint = lintCommand(options);
  const lintResult = await run(lint.command, lint.args, { env: lint.env, signal: options.signal });
  let lintFindings: LintFinding[];
  try {
    lintFindings = parseLint(lintResult.stdout);
  } catch {
    throw new CommandError("hyperframes lint", lint.command, lintResult);
  }
  if (lintFindings.some((finding) => finding.severity === "error")) {
    throw new RenderLintError(lintFindings);
  }

  const outDir = dirname(options.outputPath);
  await mkdir(outDir, { recursive: true });
  await mkdir(dirname(options.posterPath), { recursive: true });
  const rawPath = join(outDir, ".render-raw.mp4");
  const encodedPath = join(outDir, ".render-final.mp4");

  try {
    report("render");
    const render = renderCommand(options, rawPath);
    await runChecked(run, "hyperframes render", render.command, render.args, {
      env: render.env,
      signal: options.signal,
      onStdout: (chunk) => {
        const value = parseRenderProgress(chunk);
        if (value !== undefined) report("render", value);
      },
      onStderr: (chunk) => {
        const value = parseRenderProgress(chunk);
        if (value !== undefined) report("render", value);
      },
    });

    report("encode");
    const raw = await probe(rawPath);
    await runChecked(
      run,
      "ffmpeg encode",
      ffmpeg,
      encodeArgs({
        rawPath,
        outputPath: encodedPath,
        voicePath: raw.audio ? undefined : voicePath,
        loudnessLufs: options.loudnessLufs,
        durationMs: expectedDurationMs,
      }),
      { signal: options.signal },
    );
    await rename(encodedPath, options.outputPath);

    report("poster");
    const posterAt = expectedDurationMs > POSTER_AT_SECONDS * 1000 ? POSTER_AT_SECONDS : 0;
    await runChecked(
      run,
      "ffmpeg poster",
      ffmpeg,
      posterArgs(options.outputPath, options.posterPath, posterAt),
      { signal: options.signal },
    );

    report("verify");
    const delivered = await probe(options.outputPath);
    verifyDelivery(delivered, expectedDurationMs);
    const { size } = await stat(options.outputPath);
    report("done");
    return {
      outputPath: options.outputPath,
      posterPath: options.posterPath,
      durationMs: delivered.durationMs,
      width: delivered.video?.width ?? 0,
      height: delivered.video?.height ?? 0,
      sizeBytes: size,
      lintFindings,
    };
  } finally {
    await rm(rawPath, { force: true });
    await rm(encodedPath, { force: true });
  }
}
