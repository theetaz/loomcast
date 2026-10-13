import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach } from "vitest";
import type { MediaProbe } from "../src/probe.ts";
import type { CommandRunner, RunOptions, RunResult } from "../src/process.ts";

const created: string[] = [];

afterEach(async () => {
  while (created.length > 0) {
    const dir = created.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

/** A temporary directory removed after the test. */
export async function tempDir(prefix = "loomcast-runtime-test-"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

/** A throwaway provider key, generated so no credential-like literal sits in the tests. */
export function testKey(label = "key"): string {
  return [label, randomBytes(12).toString("hex")].join("-");
}

const LANDSCAPE_CARD = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <link rel="stylesheet" href="../../tokens.css" />
    <style>
      #t-card { position: absolute; inset: 0; width: 1920px; height: 1080px; background: var(--bg); }
      #t-card .headline em { font-style: italic; }
      #t-card #t-card-glow { fill: url(#t-card-grad); }
    </style>
  </head>
  <body>
    <div id="t-card" data-composition-id="t-card" data-start="0" data-width="1920" data-height="1080">
      <svg><defs><linearGradient id="t-card-grad"></linearGradient></defs><rect id="t-card-glow" /></svg>
      <div class="kicker" data-slot="kicker">KICKER PLACEHOLDER</div>
      <div class="headline" data-slot="headline">Headline <em>placeholder</em></div>
      <div class="words" data-slot="words"><span class="word" id="t-card-w0">One</span> <span class="word accent" id="t-card-w1">Two</span></div>
      <div class="scrap" data-slot="scrap"><span class="photo">IMG</span></div>
    </div>
    <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
    <script>
      window.__timelines = window.__timelines || {};
      const tl = gsap.timeline({ paused: true });
      const ids = ["t-card-w0", "t-card-w1"];
      ids.forEach((id, i) => tl.from("#" + id, { opacity: 0, duration: 0.3 }, i * 0.1));
      tl.from(document.getElementById("t-card-glow"), { opacity: 0, duration: 0.5 }, 0);
      tl.from('[data-composition-id="t-card"] .kicker', { y: 10, duration: 0.4 }, 0);
      window.__timelines["t-card"] = tl;
    </script>
  </body>
</html>
`;

const VERTICAL_CARD = `<!doctype html>
<html>
  <head><style>#v-card { width: 1080px; height: 1920px; }</style></head>
  <body>
    <div id="v-card" data-composition-id="v-card" data-start="0" data-width="1080" data-height="1920">
      <div class="title" data-slot="title">Title</div>
    </div>
    <script>
      window.__timelines = window.__timelines || {};
      window.__timelines["v-card"] = gsap.timeline({ paused: true });
    </script>
  </body>
</html>
`;

/**
 * A small style library: style `test-style` with a landscape card (`test-style.t1.section.card`,
 * 2–8 s) and a 9:16 card (`test-style.t1.thesis.vertical`, 1–10 s).
 */
export async function makeLibrary(root: string): Promise<string> {
  const library = join(root, "style-library");
  const style = join(library, "01-test-style");
  await mkdir(join(style, "cards", "tier1"), { recursive: true });
  await writeFile(join(style, "cards", "tier1", "card.html"), LANDSCAPE_CARD);
  await writeFile(join(style, "cards", "tier1", "vertical.html"), VERTICAL_CARD);
  await writeFile(
    join(style, "tokens.css"),
    '@import url("https://fonts.example.test/css2?family=A:wght@400;700&display=swap");\n:root { --bg: #101010; --fg: #fafafa; --accent: #4a52d1; }\n',
  );
  await writeFile(
    join(style, "style.json"),
    JSON.stringify({
      id: "test-style",
      cards: [
        {
          id: "test-style.t1.section.card",
          slots: [
            { name: "kicker", type: "text", maxChars: 20 },
            { name: "headline", type: "richtext", maxChars: 60 },
            { name: "words", type: "richtext" },
            { name: "scrap", type: "image" },
          ],
        },
        { id: "test-style.t1.thesis.vertical", slots: ["title"] },
      ],
    }),
  );
  await writeFile(
    join(library, "registry.json"),
    JSON.stringify({
      styles: [
        {
          id: "test-style",
          name: "Test style",
          folder: "01-test-style",
          palette: { bg: "#101010" },
          cards: [
            {
              id: "test-style.t1.section.card",
              style: "test-style",
              tier: "tier1",
              purpose: "section",
              file: "01-test-style/cards/tier1/card.html",
              slots: ["kicker", "headline", "words", "scrap"],
              duration: { min: 2, max: 8 },
            },
            {
              id: "test-style.t1.thesis.vertical",
              style: "test-style",
              tier: "tier1",
              purpose: "thesis",
              file: "01-test-style/cards/tier1/vertical.html",
              slots: ["title"],
              duration: { min: 1, max: 10 },
            },
          ],
        },
      ],
    }),
  );
  return library;
}

/**
 * A fake studio root: the test library, the real shell template, and stand-ins for GSAP and the
 * HyperFrames CLI so assembly and command construction work without node_modules.
 */
export async function makeStudio(root: string, realStudioRoot: string): Promise<string> {
  const studio = join(root, "studio");
  await mkdir(join(studio, "runtime", "templates"), { recursive: true });
  await makeLibrary(studio);
  const { cp } = await import("node:fs/promises");
  await cp(
    join(realStudioRoot, "runtime", "templates", "vertical-shell"),
    join(studio, "runtime", "templates", "vertical-shell"),
    { recursive: true },
  );
  await mkdir(join(studio, "node_modules", "gsap", "dist"), { recursive: true });
  await writeFile(join(studio, "node_modules", "gsap", "dist", "gsap.min.js"), "/* gsap */\n");
  return studio;
}

export interface RecordedCall {
  command: string;
  args: string[];
  options: RunOptions | undefined;
}

/**
 * A fake command runner. `respond` returns the result for each call; by default every call
 * succeeds silently. When the last argument looks like an output file it is created, so code
 * that renames or stats outputs keeps working.
 */
export function fakeRunner(
  respond: (call: RecordedCall) => Partial<RunResult> | undefined = () => undefined,
): { run: CommandRunner; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const run: CommandRunner = async (command, args, options) => {
    const call = { command, args: [...args], options };
    calls.push(call);
    const result = { code: 0, stdout: "", stderr: "", ...respond(call) };
    const output = args.at(-1);
    if (
      result.code === 0 &&
      command.includes("ffmpeg") &&
      output &&
      /\.(mp4|mp3|jpg)$/.test(output)
    ) {
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, "fake media");
    }
    const outIndex = args.indexOf("--output");
    const rendered = outIndex >= 0 ? args[outIndex + 1] : undefined;
    if (result.code === 0 && rendered) {
      await mkdir(dirname(rendered), { recursive: true });
      await writeFile(rendered, "fake render");
    }
    return result;
  };
  return { run, calls };
}

/** ffprobe JSON for a file with the given streams. */
export function probeJson(probe: {
  durationMs: number;
  width?: number;
  height?: number;
  audio?: boolean;
  codec?: string;
}): string {
  const streams: Record<string, unknown>[] = [];
  if (probe.width !== undefined) {
    streams.push({
      codec_type: "video",
      codec_name: probe.codec ?? "h264",
      profile: "High",
      width: probe.width,
      height: probe.height,
      avg_frame_rate: "30/1",
      pix_fmt: "yuv420p",
    });
  }
  if (probe.audio !== false) {
    streams.push({ codec_type: "audio", codec_name: "aac", sample_rate: "48000", channels: 2 });
  }
  return JSON.stringify({
    streams,
    format: { duration: String(probe.durationMs / 1000), size: "1234", format_name: "mp4" },
  });
}

export function mediaProbe(durationMs: number): MediaProbe {
  return {
    durationMs,
    sizeBytes: 1,
    formatName: "mp3",
    audio: { codec: "mp3", sampleRate: 44100, channels: 1 },
  };
}
