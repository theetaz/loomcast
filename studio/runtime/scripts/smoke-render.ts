import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { renderItem } from "../src/item.ts";
import { checkRenderTools } from "../src/preflight.ts";
import { runChecked, runCommand } from "../src/process.ts";

// Opt-in smoke render: five seconds of a real library card in the vertical shell, over a
// synthetic sine-tone "voice" made by ffmpeg, with synthetic captions. Everything is generated
// in a temporary directory and deleted afterwards (pass --keep to inspect the output).
//
//   HYPERFRAMES_NO_TELEMETRY=1 DO_NOT_TRACK=1 \
//     pnpm --filter @loomcast/studio exec tsx runtime/scripts/smoke-render.ts [--keep]

export const SMOKE_DURATION_MS = 5_000;
export const SMOKE_CARD = "vox-explainer.t1.section.circle";

export interface SmokeResult {
  durationMs: number;
  width: number;
  height: number;
  sizeBytes: number;
  elapsedMs: number;
  kept?: string;
}

export async function smokeRender(options: { keep?: boolean } = {}): Promise<SmokeResult> {
  const tools = await checkRenderTools();
  if (!tools.ready) {
    throw new Error(`Render tools are missing: ${JSON.stringify(tools)}`);
  }
  const dir = await mkdtemp(join(tmpdir(), "loomcast-smoke-"));
  const started = Date.now();
  try {
    const voicePath = join(dir, "voice.mp3");
    await runChecked(runCommand, "ffmpeg sine voice", "ffmpeg", [
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=220:sample_rate=44100:duration=${SMOKE_DURATION_MS / 1000}`,
      "-ac",
      "1",
      "-c:a",
      "libmp3lame",
      "-b:a",
      "96k",
      voicePath,
    ]);

    const spoken = "Loomcast renders vertical shorts from a storyboard in five seconds flat.";
    const words = spoken.split(" ").map((text, index) => ({
      text,
      startMs: 200 + index * 400,
      endMs: 200 + index * 400 + 320,
    }));

    const { render } = await renderItem({
      itemDir: dir,
      voicePath,
      alignment: { words },
      hook: "Smoke test: the vertical shell",
      title: "Loomcast smoke render",
      quality: "draft",
      storyboard: {
        styleId: "vox-explainer",
        fps: 30,
        aspect: "9:16",
        frames: [
          {
            id: "smoke",
            segmentId: "s1",
            startMs: 0,
            endMs: SMOKE_DURATION_MS,
            cardId: SMOKE_CARD,
            slots: {
              kicker: "Smoke test",
              headline: "Vertical <em>shell</em> works",
              source: "Synthetic content",
            },
          },
        ],
      },
    });
    return {
      durationMs: render.durationMs,
      width: render.width,
      height: render.height,
      sizeBytes: render.sizeBytes,
      elapsedMs: Date.now() - started,
      ...(options.keep ? { kept: dir } : {}),
    };
  } finally {
    if (!options.keep) await rm(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  smokeRender({ keep: process.argv.includes("--keep") }).then(
    (result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`),
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
