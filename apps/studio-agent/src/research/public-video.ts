import { type ChildProcess, spawn } from "node:child_process";
import { lstat, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { JobFailure } from "../handlers";
import { ensurePrivateDir } from "../private-fs";

// Downloads one public competitor video with `yt-dlp` and measures it with ffprobe and ffmpeg.
// Every tool is spawned directly with an argument array, never through a shell, with a minimal
// environment. `yt-dlp` gets a fixed argument list without config files, cookies, browser profiles
// or post-processing hooks, so only public videos are fetched and nothing downloaded is executed.

/** Largest video the downloader keeps, as `yt-dlp`'s `--max-filesize` and the probe check it. */
export const MAX_VIDEO_BYTES = 300 * 1024 * 1024;
/** Longest video analysed, in milliseconds (`--match-filter "duration <=? 600"`, then ffprobe). */
export const MAX_VIDEO_DURATION_MS = 600_000;
/** How long the downloader may run. */
export const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
/** How long one ffprobe or ffmpeg call may run. */
export const MEASURE_TIMEOUT_MS = 3 * 60_000;
/** Still frames taken for the session, evenly spaced over the video. */
export const FRAME_COUNT = 6;
/** Width of a still frame in pixels; the height keeps the aspect ratio. */
export const FRAME_WIDTH = 540;
/** The scene detector's threshold for a cut. */
export const SCENE_THRESHOLD = 0.3;

/** Output kept per stream, for error messages only. */
const MAX_CAPTURE = 16 * 1024;

/** The environment variables a spawned tool inherits; everything else is dropped. */
const PASSED_ENV = [
  "PATH",
  "HOME",
  "LANG",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
] as const;

/**
 * The downloader's arguments. The output template's directory has `%` doubled, so `yt-dlp` cannot
 * read part of the path as a field; the link comes last, after `--`, so it is never an option.
 */
export function ytDlpArgs(dir: string, url: string): string[] {
  return [
    "--ignore-config",
    "--no-playlist",
    "--no-cache-dir",
    "--no-mtime",
    "--no-write-info-json",
    "--no-write-thumbnail",
    "--no-write-subs",
    "--max-filesize",
    "300M",
    "--match-filter",
    // `<=?` lets a video without a known duration through (Instagram reports none); ffprobe
    // checks the length of the downloaded file either way.
    "duration <=? 600",
    "--format",
    "best[ext=mp4][height<=1920]/best[height<=1920]/best",
    "--output",
    `${dir.replaceAll("%", "%%")}/video.%(ext)s`,
    "--",
    url,
  ];
}

/** The minimal environment of a spawned tool: `PATH`, `HOME`, `LANG` and the proxy variables. */
export function toolEnvironment(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const minimal: Record<string, string> = {};
  for (const name of PASSED_ENV) {
    const value = env[name];
    if (value !== undefined && value !== "") {
      minimal[name] = value;
    }
  }
  return minimal;
}

/** The ffprobe arguments for a JSON report of a file's format and streams; `path` is absolute. */
export function probeArgs(path: string): string[] {
  return ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", path];
}

/** The ffmpeg arguments that log one `showinfo` line per detected cut and write nothing. */
export function sceneArgs(path: string): string[] {
  return [
    "-hide_banner",
    "-nostats",
    "-nostdin",
    "-i",
    path,
    "-an",
    "-sn",
    "-dn",
    "-vf",
    `select='gt(scene,${SCENE_THRESHOLD})',showinfo`,
    "-f",
    "null",
    "-",
  ];
}

/** The ffmpeg arguments that write the frame at `seconds` as a JPEG `FRAME_WIDTH` pixels wide. */
export function frameArgs(path: string, seconds: number, output: string): string[] {
  return [
    "-hide_banner",
    "-nostdin",
    "-v",
    "error",
    "-ss",
    seconds.toFixed(3),
    "-i",
    path,
    "-frames:v",
    "1",
    "-vf",
    `scale=${FRAME_WIDTH}:-2`,
    "-q:v",
    "3",
    "-y",
    output,
  ];
}

/** Evenly spaced frame times in seconds: the middle of each of `count` equal parts. */
export function frameTimes(durationMs: number, count = FRAME_COUNT): number[] {
  if (durationMs <= 0) {
    return [0];
  }
  return Array.from({ length: count }, (_, index) => ((index + 0.5) * durationMs) / count / 1000);
}

/** Counts the cuts `showinfo` logged. */
export function countSceneLines(text: string): number {
  return text.split("\n").filter((line) => /Parsed_showinfo.*\bpts_time:/.test(line)).length;
}

export interface ToolRun {
  /** The exit code, or null when the tool was killed. */
  readonly code: number | null;
  /** The last part of the output, for error messages only. */
  readonly stdout: string;
  readonly stderr: string;
  /** Whether the time limit stopped the tool. */
  readonly timedOut: boolean;
}

export interface ToolRunOptions {
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  /** Receives every stderr chunk, for counting lines without keeping them. */
  readonly onStderr?: (chunk: string) => void;
}

/** Runs a tool. Rejects with the spawn error (ENOENT for a missing binary) or an abort. */
export type ToolRunner = (
  command: string,
  args: readonly string[],
  options: ToolRunOptions,
) => Promise<ToolRun>;

type SpawnLike = (
  command: string,
  args: readonly string[],
  options: {
    env: Record<string, string>;
    shell: false;
    stdio: ["ignore", "pipe", "pipe"];
    windowsHide: true;
  },
) => Pick<ChildProcess, "stdout" | "stderr" | "on" | "kill">;

function keepTail(buffer: string, chunk: string): string {
  const next = buffer + chunk;
  return next.length > MAX_CAPTURE ? next.slice(next.length - MAX_CAPTURE) : next;
}

/**
 * A runner around `spawn` (injectable for tests): no shell, the minimal environment, bounded
 * output, killed when the job is aborted or the time limit passes.
 */
export function createToolRunner(
  spawnImpl: SpawnLike = spawn as SpawnLike,
  env: Readonly<Record<string, string | undefined>> = process.env,
): ToolRunner {
  return (command, args, options) =>
    new Promise<ToolRun>((resolve, reject) => {
      if (options.signal.aborted) {
        reject(abortError(options.signal));
        return;
      }
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;
      const child = spawnImpl(command, [...args], {
        env: toolEnvironment(env),
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      const stop = () => {
        child.kill("SIGKILL");
      };
      const timer = setTimeout(() => {
        timedOut = true;
        stop();
      }, options.timeoutMs);
      options.signal.addEventListener("abort", stop, { once: true });
      const finish = (settle: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        options.signal.removeEventListener("abort", stop);
        settle();
      };
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdout = keepTail(stdout, chunk);
      });
      child.stderr?.on("data", (chunk: string) => {
        stderr = keepTail(stderr, chunk);
        options.onStderr?.(chunk);
      });
      child.on("error", (error: Error) => finish(() => reject(error)));
      child.on("close", (code: number | null) =>
        finish(() => {
          if (options.signal.aborted) {
            reject(abortError(options.signal));
            return;
          }
          resolve({ code, stdout, stderr, timedOut });
        }),
      );
    });
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The job was aborted", "AbortError");
}

/** What ffprobe says about a downloaded file. */
export interface VideoProbe {
  readonly durationMs: number;
  readonly sizeBytes: number;
  readonly hasVideo: boolean;
  readonly hasAudio: boolean;
}

/** Turns ffprobe's JSON into a `VideoProbe`. */
export function parseVideoProbe(json: string): VideoProbe {
  const raw = JSON.parse(json) as {
    streams?: { codec_type?: string; duration?: string }[];
    format?: { duration?: string; size?: string };
  };
  const streams = raw.streams ?? [];
  const video = streams.find((stream) => stream.codec_type === "video");
  const seconds = Number(raw.format?.duration ?? video?.duration ?? 0);
  return {
    durationMs: Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : 0,
    sizeBytes: Number(raw.format?.size ?? 0) || 0,
    hasVideo: video !== undefined,
    hasAudio: streams.some((stream) => stream.codec_type === "audio"),
  };
}

/** The tools of a public-video analysis. Tests replace the whole object. */
export interface PublicVideoTools {
  /** Downloads `url` into `dir` and returns the one file it produced. */
  download(input: { url: string; dir: string; signal: AbortSignal }): Promise<string>;
  probe(path: string, signal: AbortSignal): Promise<VideoProbe>;
  /** The number of cuts the scene detector finds. */
  countCuts(path: string, signal: AbortSignal): Promise<number>;
  /** Writes up to `FRAME_COUNT` JPEG frames into `dir` and returns their paths, in time order. */
  extractFrames(input: {
    path: string;
    dir: string;
    durationMs: number;
    signal: AbortSignal;
  }): Promise<string[]>;
}

export interface PublicVideoToolsOptions {
  /** Defaults to `yt-dlp` on `PATH`. */
  readonly ytDlpPath?: string;
  readonly ffmpegPath?: string;
  readonly ffprobePath?: string;
  readonly run?: ToolRunner;
}

/** The real tools: `yt-dlp`, ffprobe and ffmpeg spawned through `run`. */
export function createPublicVideoTools(options: PublicVideoToolsOptions = {}): PublicVideoTools {
  const run = options.run ?? createToolRunner();
  const ytDlp = options.ytDlpPath ?? "yt-dlp";
  const ffmpeg = options.ffmpegPath ?? "ffmpeg";
  const ffprobe = options.ffprobePath ?? "ffprobe";

  const measure = async (
    label: string,
    command: string,
    args: readonly string[],
    signal: AbortSignal,
    onStderr?: (chunk: string) => void,
  ): Promise<ToolRun> => {
    let result: ToolRun;
    try {
      result = await run(command, args, { signal, timeoutMs: MEASURE_TIMEOUT_MS, onStderr });
    } catch (error) {
      if (isErrorCode(error, "ENOENT")) {
        throw new JobFailure(
          "media_tools_missing",
          `${label} is not installed or not on PATH; install ffmpeg (for example with Homebrew)`,
          false,
        );
      }
      throw error;
    }
    if (result.code !== 0) {
      throw new JobFailure(
        "media_probe_failed",
        `${label} failed${result.timedOut ? " (time limit)" : ""}: ${sanitizeToolOutput(result.stderr)}`,
        false,
      );
    }
    return result;
  };

  return {
    async download({ url, dir, signal }) {
      let result: ToolRun;
      try {
        result = await run(ytDlp, ytDlpArgs(dir, url), {
          signal,
          timeoutMs: DOWNLOAD_TIMEOUT_MS,
        });
      } catch (error) {
        if (isErrorCode(error, "ENOENT") || isErrorCode(error, "EACCES")) {
          throw new JobFailure(
            "downloader_missing",
            "yt-dlp is not installed on this Mac; install yt-dlp (for example with Homebrew) or set ytDlpPath in the agent config",
            false,
          );
        }
        throw error;
      }
      if (result.timedOut) {
        throw new JobFailure(
          "download_failed",
          "The download did not finish within 5 minutes",
          true,
        );
      }
      if (result.code !== 0) {
        const reason = sanitizeToolOutput(result.stderr || result.stdout);
        throw new JobFailure(
          "download_failed",
          `The video could not be downloaded: ${reason}`,
          isRetryableDownloadError(reason),
        );
      }
      return findDownloadedFile(dir, `${result.stdout}\n${result.stderr}`);
    },

    async probe(path, signal) {
      const result = await measure("ffprobe", ffprobe, probeArgs(path), signal);
      try {
        return parseVideoProbe(result.stdout);
      } catch {
        throw new JobFailure("media_probe_failed", "ffprobe returned an unreadable report", false);
      }
    },

    async countCuts(path, signal) {
      let pending = "";
      let cuts = 0;
      const onStderr = (chunk: string) => {
        const lines = (pending + chunk).split("\n");
        pending = lines.pop() ?? "";
        cuts += countSceneLines(lines.join("\n"));
      };
      await measure("ffmpeg scene detection", ffmpeg, sceneArgs(path), signal, onStderr);
      return cuts + countSceneLines(pending);
    },

    async extractFrames({ path, dir, durationMs, signal }) {
      ensurePrivateDir(dir);
      const frames: string[] = [];
      for (const [index, seconds] of frameTimes(durationMs).entries()) {
        const output = join(dir, `frame-${index + 1}.jpg`);
        await measure("ffmpeg frame extraction", ffmpeg, frameArgs(path, seconds, output), signal);
        if (await isRegularFile(output)) {
          frames.push(output);
        }
      }
      return frames;
    },
  };
}

/**
 * The one regular file the downloader left in `dir`. No file means `yt-dlp` skipped the video
 * because of a limit; partial or extra files mean the download did not finish cleanly.
 */
async function findDownloadedFile(dir: string, output: string): Promise<string> {
  const names = (await readdir(dir)).filter((name) => name !== "frames");
  if (names.length === 0) {
    if (/does not pass filter/i.test(output)) {
      throw new JobFailure("video_too_long", "The video is longer than 10 minutes", false);
    }
    if (/larger than max-filesize/i.test(output)) {
      throw new JobFailure("video_too_large", "The video is larger than 300 MB", false);
    }
    throw new JobFailure("download_failed", "The downloader produced no video file", false);
  }
  const name = names[0];
  if (names.length > 1 || name === undefined || !/^video\.[A-Za-z0-9]{1,8}$/.test(name)) {
    throw new JobFailure(
      "download_failed",
      "The downloader did not produce exactly one video file",
      false,
    );
  }
  const path = join(dir, name);
  if (!(await isRegularFile(path))) {
    throw new JobFailure("download_failed", "The downloaded video is not a regular file", false);
  }
  return path;
}

async function isRegularFile(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile();
  } catch {
    return false;
  }
}

/** Network trouble and rate limits may pass; a private, removed or unsupported video will not. */
function isRetryableDownloadError(reason: string): boolean {
  return /timed? ?out|temporar|connection|network|unreachable|HTTP Error (?:429|5\d\d)|rate.?limit/i.test(
    reason,
  );
}

/**
 * A short, safe reason from a tool's output: the last `ERROR:` line (or the last line), without
 * control characters, links or the home directory, cut to 300 characters.
 */
export function sanitizeToolOutput(text: string, home: string = homedir()): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const error = [...lines].reverse().find((line) => line.startsWith("ERROR:"));
  let reason = error ?? lines.at(-1) ?? "no output";
  reason = reason
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it strips
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/https?:\/\/\S+/gi, "<link>");
  if (home.length > 1) {
    reason = reason.replaceAll(home, "~");
  }
  return reason.length <= 300 ? reason : `${reason.slice(0, 299)}…`;
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
