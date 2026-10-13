import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { studioPaths } from "../src/paths.ts";
import { parseProbe, probeArgs } from "../src/probe.ts";
import { CommandError, createCommandRunner, TOOL_ENV, toolEnv } from "../src/process.ts";
import {
  encodeArgs,
  lintCommand,
  parseLint,
  parseRenderProgress,
  posterArgs,
  RenderLintError,
  type RenderProgress,
  RenderVerificationError,
  renderCommand,
  renderProject,
  verifyDelivery,
} from "../src/render.ts";
import { sha256File, sha256Hex } from "../src/sha256.ts";
import { fakeRunner, probeJson, type RecordedCall, tempDir } from "./support.ts";

const LINT_OK = JSON.stringify({
  ok: true,
  errorCount: 0,
  findings: [{ code: "pointer_events_none", severity: "info", message: "info only", file: "x" }],
});

describe("the command runner", () => {
  function fakeSpawn(code: number, stdout = "", stderr = "") {
    const calls: { command: string; args: readonly string[]; options: Record<string, unknown> }[] =
      [];
    const spawnImpl = (command: string, args: readonly string[], options: object) => {
      calls.push({ command, args, options: options as Record<string, unknown> });
      const child = new EventEmitter() as EventEmitter & {
        stdout: PassThrough;
        stderr: PassThrough;
      };
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      setImmediate(() => {
        child.stdout.end(stdout);
        child.stderr.end(stderr);
        setImmediate(() => child.emit("close", code));
      });
      return child as never;
    };
    return { spawnImpl, calls };
  }

  it("spawns argument arrays without a shell and with telemetry and updates off", async () => {
    const { spawnImpl, calls } = fakeSpawn(0, "out", "err");
    const run = createCommandRunner(spawnImpl);
    const seen: string[] = [];
    const result = await run("node", ["cli.mjs", "render", "dir with spaces; rm -rf /"], {
      env: { HYPERFRAMES_BROWSER_PATH: "/opt/chrome", DO_NOT_TRACK: "0" },
      onStdout: (chunk) => seen.push(chunk),
    });
    expect(result).toEqual({ code: 0, stdout: "out", stderr: "err" });
    expect(seen).toEqual(["out"]);
    const [call] = calls;
    expect(call?.command).toBe("node");
    expect(call?.args).toEqual(["cli.mjs", "render", "dir with spaces; rm -rf /"]);
    expect(call?.options.shell).toBe(false);
    const env = call?.options.env as Record<string, string>;
    expect(env).toMatchObject({
      HYPERFRAMES_NO_TELEMETRY: "1",
      DO_NOT_TRACK: "1",
      HYPERFRAMES_NO_UPDATE_CHECK: "1",
      HYPERFRAMES_NO_AUTO_INSTALL: "1",
      HYPERFRAMES_BROWSER_PATH: "/opt/chrome",
    });
  });

  it("always lets the tool flags win over the caller's environment", () => {
    const env = toolEnv({ PATH: "/bin", HYPERFRAMES_NO_TELEMETRY: "0" }, { DO_NOT_TRACK: "0" });
    expect(env).toEqual({ PATH: "/bin", ...TOOL_ENV });
  });

  it("reports a non-zero exit with the tail of the output", async () => {
    const { spawnImpl } = fakeSpawn(3, "", "boom");
    const run = createCommandRunner(spawnImpl);
    const error = new CommandError("ffmpeg encode", "ffmpeg", await run("ffmpeg", []));
    expect(error.message).toBe("ffmpeg encode failed with exit code 3: boom");
  });
});

describe("render commands", () => {
  const studioRoot = studioPaths().root;
  const options = {
    renderDir: "/work/item/render",
    outputPath: "/work/item/out/final.mp4",
    posterPath: "/work/item/poster.jpg",
    studioRoot,
    nodePath: "/usr/bin/node",
  };

  it("lints and renders with the studio's pinned CLI and recorded flags", () => {
    const bin = studioPaths(studioRoot).hyperframesBin;
    expect(bin).toMatch(/node_modules\/hyperframes\/bin\/hyperframes\.mjs$/);
    expect(lintCommand(options)).toEqual({
      command: "/usr/bin/node",
      args: [bin, "lint", "/work/item/render", "--json"],
      env: {},
    });
    expect(
      renderCommand(
        { ...options, quality: "high", workers: 2, browserPath: "/opt/chrome" },
        "/raw.mp4",
      ),
    ).toEqual({
      command: "/usr/bin/node",
      args: [
        bin,
        "render",
        "/work/item/render",
        "--output",
        "/raw.mp4",
        "--fps",
        "30",
        "--quality",
        "high",
        "--format",
        "mp4",
        "--workers",
        "2",
      ],
      env: { HYPERFRAMES_BROWSER_PATH: "/opt/chrome" },
    });
  });

  it("encodes the delivery format, muxing the voice only when asked", () => {
    const args = encodeArgs({ rawPath: "raw.mp4", outputPath: "final.mp4", durationMs: 6_000 });
    expect(args).toEqual([
      "-y",
      "-v",
      "error",
      "-i",
      "raw.mp4",
      "-map",
      "0:v:0",
      "-map",
      "0:a:0",
      "-af",
      "loudnorm=I=-14:TP=-1.5:LRA=11",
      "-c:v",
      "libx264",
      "-profile:v",
      "high",
      "-pix_fmt",
      "yuv420p",
      "-r",
      "30",
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
      "-t",
      "6.000",
      "final.mp4",
    ]);
    const muxed = encodeArgs({ rawPath: "raw.mp4", outputPath: "o.mp4", voicePath: "voice.mp3" });
    expect(muxed.slice(3, 11)).toEqual([
      "-i",
      "raw.mp4",
      "-i",
      "voice.mp3",
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
    ]);
    expect(posterArgs("o.mp4", "p.jpg", 1)).toEqual([
      "-y",
      "-v",
      "error",
      "-ss",
      "1",
      "-i",
      "o.mp4",
      "-frames:v",
      "1",
      "-q:v",
      "2",
      "p.jpg",
    ]);
    expect(probeArgs("o.mp4")).toEqual([
      "-v",
      "error",
      "-print_format",
      "json",
      "-show_format",
      "-show_streams",
      "o.mp4",
    ]);
  });

  it("reads progress from the CLI's bar and trace lines", () => {
    expect(parseRenderProgress("\u001b[32m  ████░░  48%  Capturing frame 90/180 (6 workers)")).toBe(
      0.48,
    );
    expect(
      parseRenderProgress("  ██  75%  Encoding video\r  ██  90%  Assembling final video"),
    ).toBe(0.9);
    expect(parseRenderProgress('{"phase":"capture","framesCompleted":90,"totalFrames":180}')).toBe(
      0.35,
    );
    expect(parseRenderProgress("[INFO] Compiled composition metadata")).toBeUndefined();
  });

  it("parses lint reports and checks the delivered file", () => {
    expect(parseLint(`noise\n${LINT_OK}`)).toEqual([
      { code: "pointer_events_none", severity: "info", message: "info only", file: "x" },
    ]);
    expect(() => parseLint("no json")).toThrow(/no JSON/);

    const good = parseProbe(probeJson({ durationMs: 6_100, width: 1080, height: 1920 }));
    expect(() => verifyDelivery(good, 6_000)).not.toThrow();
    expect(() => verifyDelivery(good, 5_500)).toThrow(RenderVerificationError);
    const landscape = parseProbe(probeJson({ durationMs: 6_000, width: 1920, height: 1080 }));
    expect(() => verifyDelivery(landscape, 6_000)).toThrow(/1080x1920/);
    const silent = parseProbe(
      probeJson({ durationMs: 6_000, width: 1080, height: 1920, audio: false }),
    );
    expect(() => verifyDelivery(silent, 6_000)).toThrow(/no audio/);
  });
});

describe("renderProject", () => {
  function responder(options: { rawHasAudio?: boolean; lint?: string; finalWidth?: number } = {}) {
    return (call: RecordedCall) => {
      if (call.args.includes("lint")) return { stdout: options.lint ?? LINT_OK };
      if (call.args.includes("render")) {
        call.options?.onStderr?.("  ███  20%  Capturing frame 36/180\n");
        call.options?.onStdout?.("  █████  70%  Capturing frame 180/180\n");
        return { stdout: "done" };
      }
      if (call.command === "ffprobe") {
        const path = call.args.at(-1) ?? "";
        if (path.endsWith("voice.mp3")) return { stdout: probeJson({ durationMs: 6_000 }) };
        if (path.includes(".render-raw")) {
          return {
            stdout: probeJson({
              durationMs: 6_000,
              width: 1080,
              height: 1920,
              audio: options.rawHasAudio ?? true,
            }),
          };
        }
        return {
          stdout: probeJson({ durationMs: 6_020, width: options.finalWidth ?? 1080, height: 1920 }),
        };
      }
      return undefined;
    };
  }

  async function setup() {
    const dir = await tempDir();
    const renderDir = join(dir, "render");
    return {
      dir,
      options: {
        renderDir,
        outputPath: join(dir, "out", "final.mp4"),
        posterPath: join(dir, "poster.jpg"),
        studioRoot: studioPaths().root,
      },
    };
  }

  it("lints, renders, encodes, takes a poster and verifies, reporting progress", async () => {
    const { dir, options } = await setup();
    const { run, calls } = fakeRunner(responder());
    const progress: RenderProgress[] = [];
    const result = await renderProject({ ...options, run, onProgress: (p) => progress.push(p) });

    expect(result).toEqual({
      outputPath: options.outputPath,
      posterPath: options.posterPath,
      durationMs: 6_020,
      width: 1080,
      height: 1920,
      sizeBytes: expect.any(Number),
      lintFindings: [expect.objectContaining({ code: "pointer_events_none" })],
    });
    const steps = calls.map((call) =>
      call.command === process.execPath
        ? `hyperframes ${call.args[1]}`
        : `${call.command} ${call.args.at(-1)?.split("/").at(-1)}`,
    );
    expect(steps).toEqual([
      "ffprobe voice.mp3",
      "hyperframes lint",
      "hyperframes render",
      "ffprobe .render-raw.mp4",
      "ffmpeg .render-final.mp4",
      "ffmpeg poster.jpg",
      "ffprobe final.mp4",
    ]);
    // The renderer muxed audio, so the encode keeps it rather than adding the voice again.
    const encode = calls.find((call) => call.args.includes("libx264"));
    expect(encode?.args).not.toContain(join(options.renderDir, "assets", "voice.mp3"));
    expect(encode?.args).toContain("0:a:0");
    // Intermediate files are cleaned up; outputs remain.
    expect(existsSync(join(dir, "out", ".render-raw.mp4"))).toBe(false);
    expect(existsSync(options.outputPath)).toBe(true);

    const fractions = progress.map((p) => p.fraction);
    expect(fractions).toEqual([...fractions].sort((a, b) => a - b));
    expect(progress[0]).toEqual({ stage: "lint", fraction: 0 });
    expect(progress.at(-1)).toEqual({ stage: "done", fraction: 1 });
    expect(progress.map((p) => p.stage)).toEqual(
      expect.arrayContaining(["render", "encode", "poster", "verify"]),
    );
    expect(progress.filter((p) => p.stage === "render").length).toBeGreaterThanOrEqual(3);
  });

  it("muxes the voice when the renderer produced no audio", async () => {
    const { options } = await setup();
    const { run, calls } = fakeRunner(responder({ rawHasAudio: false }));
    await renderProject({ ...options, run, expectedDurationMs: 6_000 });
    const encode = calls.find((call) => call.args.includes("libx264"));
    expect(encode?.args).toContain(join(options.renderDir, "assets", "voice.mp3"));
    expect(encode?.args).toContain("1:a:0");
    expect(calls[0]?.args).toContain("lint");
  });

  it("stops before rendering when lint reports errors", async () => {
    const { options } = await setup();
    const lint = JSON.stringify({
      findings: [{ code: "missing_timeline_registry", severity: "error", message: "nope" }],
    });
    const { run, calls } = fakeRunner(responder({ lint }));
    await expect(
      renderProject({ ...options, run, expectedDurationMs: 6_000 }),
    ).rejects.toBeInstanceOf(RenderLintError);
    expect(calls.some((call) => call.args.includes("render"))).toBe(false);
  });

  it("fails verification when the delivered file has the wrong size", async () => {
    const { options } = await setup();
    const { run } = fakeRunner(responder({ finalWidth: 720 }));
    await expect(renderProject({ ...options, run, expectedDurationMs: 6_000 })).rejects.toThrow(
      /1080x1920/,
    );
  });

  it("surfaces a failed render with its exit code", async () => {
    const { options } = await setup();
    const { run } = fakeRunner((call) =>
      call.args.includes("lint")
        ? { stdout: LINT_OK }
        : call.args.includes("render")
          ? { code: 1, stderr: "chrome crashed" }
          : undefined,
    );
    await expect(renderProject({ ...options, run, expectedDurationMs: 6_000 })).rejects.toThrow(
      "hyperframes render failed with exit code 1: chrome crashed",
    );
  });
});

describe("probe and sha256", () => {
  it("parses ffprobe JSON", () => {
    expect(parseProbe(probeJson({ durationMs: 5_100, width: 1080, height: 1920 }))).toEqual({
      durationMs: 5_100,
      sizeBytes: 1234,
      formatName: "mp4",
      video: {
        codec: "h264",
        profile: "High",
        width: 1080,
        height: 1920,
        fps: 30,
        pixelFormat: "yuv420p",
      },
      audio: { codec: "aac", sampleRate: 48000, channels: 2 },
    });
  });

  it("hashes files by streaming", async () => {
    const path = join(await tempDir(), "data.bin");
    await writeFile(path, "loomcast");
    expect(await sha256File(path)).toEqual({ sha256: sha256Hex("loomcast"), sizeBytes: 8 });
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(await readFile(path, "utf8")).toBe("loomcast");
  });
});
