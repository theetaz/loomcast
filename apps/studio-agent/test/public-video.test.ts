import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  countSceneLines,
  createPublicVideoTools,
  createToolRunner,
  DOWNLOAD_TIMEOUT_MS,
  FRAME_COUNT,
  frameArgs,
  frameTimes,
  parseVideoProbe,
  sanitizeToolOutput,
  sceneArgs,
  type ToolRun,
  type ToolRunner,
  toolEnvironment,
  ytDlpArgs,
} from "../src/research/public-video";

const URL_ = "https://www.instagram.com/reel/Ded7fL-DkFd/";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "loomcast-public-video-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("yt-dlp arguments", () => {
  it("uses exactly the fixed argument list, with the link last after --", () => {
    expect(ytDlpArgs("/work/media-1", URL_)).toEqual([
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
      "duration <=? 600",
      "--format",
      "best[ext=mp4][height<=1920]/best[height<=1920]/best",
      "--output",
      "/work/media-1/video.%(ext)s",
      "--",
      URL_,
    ]);
  });

  it("never passes cookies, browser profiles, config files or hooks", () => {
    const args = ytDlpArgs("/work", URL_).join(" ");
    for (const flag of [
      "--cookies",
      "--cookies-from-browser",
      "--exec",
      "--config-location",
      "--username",
      "--password",
      "--netrc",
      "--load-info-json",
      "--batch-file",
    ]) {
      expect(args).not.toContain(flag);
    }
  });

  it("escapes % in the directory so it cannot become a template field", () => {
    expect(ytDlpArgs("/work/100%(id)s", URL_)).toContain("/work/100%%(id)s/video.%(ext)s");
  });

  it("keeps a link that looks like an option after --", () => {
    const args = ytDlpArgs("/work", "--exec=rm");
    expect(args.at(-2)).toBe("--");
    expect(args.at(-1)).toBe("--exec=rm");
  });
});

describe("tool environment", () => {
  it("keeps only PATH, HOME, LANG and the proxy variables", () => {
    expect(
      toolEnvironment({
        PATH: "/usr/bin",
        HOME: "/Users/me",
        LANG: "en_US.UTF-8",
        https_proxy: "http://proxy:8080",
        NO_PROXY: "localhost",
        LOOMCAST_VOICE_PROVIDER_KEY: "secret",
        ANTHROPIC_API_KEY: "secret",
        AWS_SECRET_ACCESS_KEY: "secret",
        SSH_AUTH_SOCK: "/tmp/agent",
        PYTHONPATH: "/evil",
        YTDLP_CONFIG: "x",
        EMPTY: "",
        LC_ALL: "",
      }),
    ).toEqual({
      PATH: "/usr/bin",
      HOME: "/Users/me",
      LANG: "en_US.UTF-8",
      https_proxy: "http://proxy:8080",
      NO_PROXY: "localhost",
    });
  });
});

/** A child process stand-in that writes `stderr`, then exits with `code`. */
function fakeChild(script: {
  code?: number | null;
  stdout?: string;
  stderr?: string;
  error?: NodeJS.ErrnoException;
  hang?: boolean;
}) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter & { setEncoding: () => void };
    stderr: EventEmitter & { setEncoding: () => void };
    kill: (signal?: string) => boolean;
    killed: string[];
  };
  const stream = () => Object.assign(new EventEmitter(), { setEncoding: () => {} });
  child.stdout = stream();
  child.stderr = stream();
  child.killed = [];
  child.kill = (signal = "SIGTERM") => {
    child.killed.push(signal);
    queueMicrotask(() => child.emit("close", null));
    return true;
  };
  queueMicrotask(() => {
    if (script.error !== undefined) {
      child.emit("error", script.error);
      return;
    }
    if (script.stdout !== undefined) child.stdout.emit("data", script.stdout);
    if (script.stderr !== undefined) child.stderr.emit("data", script.stderr);
    if (!script.hang) child.emit("close", script.code ?? 0);
  });
  return Object.assign(child as unknown as ChildProcess, { kills: child.killed });
}

describe("tool runner", () => {
  it("spawns without a shell, with the minimal environment and bounded output", async () => {
    const calls: { command: string; args: readonly string[]; options: unknown }[] = [];
    const run = createToolRunner(
      (command, args, options) => {
        calls.push({ command, args, options });
        return fakeChild({ code: 0, stdout: "x".repeat(40_000), stderr: "done" });
      },
      { PATH: "/bin", HOME: "/h", LOOMCAST_VOICE_PROVIDER_KEY: "secret" },
    );
    const result = await run("yt-dlp", ["--", URL_], {
      signal: new AbortController().signal,
      timeoutMs: 1_000,
    });
    expect(calls).toEqual([
      {
        command: "yt-dlp",
        args: ["--", URL_],
        options: {
          env: { PATH: "/bin", HOME: "/h" },
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        },
      },
    ]);
    expect(result).toMatchObject({ code: 0, stderr: "done", timedOut: false });
    expect(result.stdout.length).toBeLessThanOrEqual(16 * 1024);
  });

  it("kills the tool at the time limit and on abort", async () => {
    const children: ReturnType<typeof fakeChild>[] = [];
    const run = createToolRunner(() => {
      const child = fakeChild({ hang: true });
      children.push(child);
      return child;
    });
    const timed = await run("yt-dlp", [], {
      signal: new AbortController().signal,
      timeoutMs: 5,
    });
    expect(timed.timedOut).toBe(true);
    expect(children[0]?.kills).toEqual(["SIGKILL"]);

    const controller = new AbortController();
    const pending = run("yt-dlp", [], { signal: controller.signal, timeoutMs: 60_000 });
    await Promise.resolve();
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(children[1]?.kills).toEqual(["SIGKILL"]);
  });
});

/** A runner that records calls and answers from `respond`. */
function scriptedRunner(
  respond: (command: string, args: readonly string[]) => Partial<ToolRun> | Error,
): ToolRunner & { calls: { command: string; args: readonly string[]; timeoutMs: number }[] } {
  const calls: { command: string; args: readonly string[]; timeoutMs: number }[] = [];
  const run = (async (command, args, options) => {
    calls.push({ command, args, timeoutMs: options.timeoutMs });
    const answer = respond(command, args);
    if (answer instanceof Error) {
      throw answer;
    }
    if (answer.stderr !== undefined) {
      options.onStderr?.(answer.stderr);
    }
    return { code: 0, stdout: "", stderr: "", timedOut: false, ...answer };
  }) as ToolRunner & { calls: typeof calls };
  run.calls = calls;
  return run;
}

function enoent(): NodeJS.ErrnoException {
  return Object.assign(new Error("spawn yt-dlp ENOENT"), { code: "ENOENT" });
}

describe("public video tools", () => {
  const signal = new AbortController().signal;

  it("downloads with the configured yt-dlp and returns the one file", async () => {
    const run = scriptedRunner(() => {
      writeFileSync(join(dir, "video.mp4"), "mp4");
      return {};
    });
    const tools = createPublicVideoTools({ ytDlpPath: "/opt/bin/yt-dlp", run });
    expect(await tools.download({ url: URL_, dir, signal })).toBe(join(dir, "video.mp4"));
    expect(run.calls).toEqual([
      { command: "/opt/bin/yt-dlp", args: ytDlpArgs(dir, URL_), timeoutMs: DOWNLOAD_TIMEOUT_MS },
    ]);
  });

  it("fails as downloader_missing when yt-dlp is not installed", async () => {
    const tools = createPublicVideoTools({ run: scriptedRunner(() => enoent()) });
    await expect(tools.download({ url: URL_, dir, signal })).rejects.toMatchObject({
      name: "JobFailure",
      code: "downloader_missing",
      retryable: false,
      message: expect.stringContaining("install yt-dlp"),
    });
  });

  it("fails with a short reason without links or the home directory", async () => {
    const home = process.env.HOME ?? "/Users/me";
    const run = scriptedRunner(() => ({
      code: 1,
      stderr: `[instagram] Extracting URL: ${URL_}\nERROR: [instagram] Ded7fL: Requested content is not available, rate-limit reached or login required. ${URL_}?igsh=abc cache ${home}/.cache`,
    }));
    const failure = await createPublicVideoTools({ run })
      .download({ url: URL_, dir, signal })
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "download_failed", retryable: true });
    const message = (failure as Error).message;
    expect(message).toContain("login required");
    expect(message).not.toContain("instagram.com");
    expect(message).not.toContain(home);
    expect(message.length).toBeLessThan(400);

    const permanent = await createPublicVideoTools({
      run: scriptedRunner(() => ({ code: 1, stderr: "ERROR: Unsupported URL" })),
    })
      .download({ url: URL_, dir, signal })
      .catch((error: unknown) => error);
    expect(permanent).toMatchObject({ code: "download_failed", retryable: false });
  });

  it("fails at the time limit, and when the filters skipped the video", async () => {
    await expect(
      createPublicVideoTools({
        run: scriptedRunner(() => ({ code: null, timedOut: true })),
      }).download({ url: URL_, dir, signal }),
    ).rejects.toMatchObject({ code: "download_failed", retryable: true });
    await expect(
      createPublicVideoTools({
        run: scriptedRunner(() => ({
          stdout: "[download] Reel does not pass filter (duration <=? 600), skipping ..",
        })),
      }).download({ url: URL_, dir, signal }),
    ).rejects.toMatchObject({ code: "video_too_long" });
    await expect(
      createPublicVideoTools({
        run: scriptedRunner(() => ({
          stdout: "[download] File is larger than max-filesize (400 bytes > 300 bytes). Aborting.",
        })),
      }).download({ url: URL_, dir, signal }),
    ).rejects.toMatchObject({ code: "video_too_large" });
  });

  it("refuses more than one file or a file that is not the video", async () => {
    const run = scriptedRunner(() => {
      writeFileSync(join(dir, "video.mp4"), "mp4");
      writeFileSync(join(dir, "video.mp4.part"), "part");
      return {};
    });
    await expect(
      createPublicVideoTools({ run }).download({ url: URL_, dir, signal }),
    ).rejects.toMatchObject({ code: "download_failed" });

    const other = mkdtempSync(join(tmpdir(), "loomcast-public-video-"));
    try {
      const dirRun = scriptedRunner(() => {
        mkdirSync(join(other, "video.mp4"));
        return {};
      });
      await expect(
        createPublicVideoTools({ run: dirRun }).download({ url: URL_, dir: other, signal }),
      ).rejects.toMatchObject({ code: "download_failed" });
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("probes, counts cuts and takes evenly spaced frames with ffprobe and ffmpeg", async () => {
    const run = scriptedRunner((command, args) => {
      if (command === "ffprobe") {
        return {
          stdout: JSON.stringify({
            streams: [{ codec_type: "video" }, { codec_type: "audio" }],
            format: { duration: "30.5", size: "1000" },
          }),
        };
      }
      if (args.includes("null")) {
        return {
          stderr:
            "[Parsed_showinfo_1 @ 0x1] n:   0 pts:  100 pts_time:1.0 pos:1\n" +
            "[Parsed_showinfo_1 @ 0x1] n:   1 pts:  200 pts_time:2.0 pos:2\nframe=  90\n",
        };
      }
      writeFileSync(String(args.at(-1)), "jpg");
      return {};
    });
    const tools = createPublicVideoTools({ run });
    const video = join(dir, "video.mp4");
    expect(await tools.probe(video, signal)).toEqual({
      durationMs: 30_500,
      sizeBytes: 1000,
      hasVideo: true,
      hasAudio: true,
    });
    expect(await tools.countCuts(video, signal)).toBe(2);
    const frames = await tools.extractFrames({
      path: video,
      dir: join(dir, "frames"),
      durationMs: 60_000,
      signal,
    });
    expect(frames).toHaveLength(FRAME_COUNT);
    expect(frames[0]).toBe(join(dir, "frames", "frame-1.jpg"));
    expect(run.calls.map((call) => call.command)).toEqual([
      "ffprobe",
      "ffmpeg",
      ...Array(FRAME_COUNT).fill("ffmpeg"),
    ]);
    expect(run.calls[1]?.args).toEqual(sceneArgs(video));
    expect(run.calls[2]?.args).toEqual(frameArgs(video, 5, join(dir, "frames", "frame-1.jpg")));
  });

  it("fails as media_tools_missing without ffmpeg", async () => {
    const tools = createPublicVideoTools({ run: scriptedRunner(() => enoent()) });
    await expect(tools.probe(join(dir, "video.mp4"), signal)).rejects.toMatchObject({
      code: "media_tools_missing",
    });
  });
});

describe("measurement helpers", () => {
  it("spaces frames over the video and scales them to 540 px", () => {
    expect(frameTimes(60_000)).toEqual([5, 15, 25, 35, 45, 55]);
    expect(frameTimes(0)).toEqual([0]);
    expect(frameArgs("/v.mp4", 1.5, "/f.jpg")).toEqual([
      "-hide_banner",
      "-nostdin",
      "-v",
      "error",
      "-ss",
      "1.500",
      "-i",
      "/v.mp4",
      "-frames:v",
      "1",
      "-vf",
      "scale=540:-2",
      "-q:v",
      "3",
      "-y",
      "/f.jpg",
    ]);
    expect(sceneArgs("/v.mp4")).toContain("select='gt(scene,0.3)',showinfo");
  });

  it("counts showinfo lines and reads ffprobe reports", () => {
    expect(countSceneLines("[Parsed_showinfo_1 @ 0x] n:0 pts_time:1\nother line\n")).toBe(1);
    expect(parseVideoProbe(JSON.stringify({ streams: [{ codec_type: "audio" }] }))).toEqual({
      durationMs: 0,
      sizeBytes: 0,
      hasVideo: false,
      hasAudio: true,
    });
  });

  it("sanitizes tool output", () => {
    expect(
      sanitizeToolOutput("WARNING: x\nERROR: bad https://x.example/a?token=1\nlast", "/Users/me"),
    ).toBe("ERROR: bad <link>");
    expect(sanitizeToolOutput("no file in /Users/me/Loomcast", "/Users/me")).toBe(
      "no file in ~/Loomcast",
    );
    expect(sanitizeToolOutput("")).toBe("no output");
    expect(sanitizeToolOutput("x".repeat(1_000)).length).toBe(300);
  });
});
