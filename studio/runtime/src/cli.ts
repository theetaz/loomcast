import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { ScriptSchema, VoiceAlignmentSchema } from "@loomcast/contracts";
import { assembleProject } from "./assemble.ts";
import { itemLayout } from "./item.ts";
import { probeMedia } from "./probe.ts";
import { loadRegistry } from "./registry.ts";
import { type RenderQuality, renderProject } from "./render.ts";
import { sha256File } from "./sha256.ts";
import { hasErrors, validateStoryboard } from "./storyboard.ts";

// pnpm --filter @loomcast/studio runtime <command> ...
//   validate <storyboard.json> [--voice-duration-ms N]
//   assemble <itemDir> [--storyboard F] [--voice F] [--alignment F] [--script F] [--hook TEXT]
//   render <itemDir> [--quality draft|standard|high] [--workers N]
//   probe <file>

const USAGE = `Usage: studio runtime <command>

  validate <storyboard.json> [--voice-duration-ms N]
      Check a storyboard against the style library. Exits 1 on errors.
  assemble <itemDir> [--storyboard F] [--voice F] [--alignment F] [--script F] [--hook TEXT]
      Build the HyperFrames project at <itemDir>/render from the version's files.
  render <itemDir> [--quality draft|standard|high] [--workers N]
      Lint, render, encode and verify <itemDir>/render into out/final.mp4 and poster.jpg.
  probe <file>
      Print a media file's metadata, size and SHA-256.
`;

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

async function readOptionalJson(path: string): Promise<unknown | undefined> {
  try {
    return await readJson(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      "voice-duration-ms": { type: "string" },
      storyboard: { type: "string" },
      voice: { type: "string" },
      alignment: { type: "string" },
      script: { type: "string" },
      hook: { type: "string" },
      quality: { type: "string" },
      workers: { type: "string" },
    },
  });
  const target = positionals[0] ? resolve(positionals[0]) : undefined;

  if (!command || command === "help" || command === "--help" || !target) {
    process.stderr.write(USAGE);
    return command && command !== "help" && command !== "--help" ? 1 : 0;
  }

  switch (command) {
    case "validate": {
      const voiceDurationMs = values["voice-duration-ms"]
        ? Number(values["voice-duration-ms"])
        : undefined;
      const issues = validateStoryboard(await readJson(target), loadRegistry(), {
        voiceDurationMs,
      });
      print({ ok: !hasErrors(issues), issues });
      return hasErrors(issues) ? 1 : 0;
    }
    case "assemble": {
      const layout = itemLayout(target);
      const voicePath = resolve(values.voice ?? layout.voice);
      const script = await readOptionalJson(resolve(values.script ?? layout.script));
      const parsedScript = script === undefined ? undefined : ScriptSchema.parse(script);
      const alignment = await readOptionalJson(resolve(values.alignment ?? layout.alignment));
      const result = await assembleProject({
        itemDir: target,
        storyboard: await readJson(resolve(values.storyboard ?? layout.storyboard)),
        voicePath,
        voiceDurationMs: (await probeMedia(voicePath)).durationMs,
        alignment: alignment === undefined ? undefined : VoiceAlignmentSchema.parse(alignment),
        hook: values.hook ?? parsedScript?.hook,
        title: parsedScript?.title,
      });
      print(result);
      return 0;
    }
    case "render": {
      const layout = itemLayout(target);
      const quality = (values.quality ?? "standard") as RenderQuality;
      if (!["draft", "standard", "high"].includes(quality)) throw new Error("Unknown --quality");
      const result = await renderProject({
        renderDir: layout.renderDir,
        outputPath: layout.output,
        posterPath: layout.poster,
        quality,
        workers: values.workers ? Number(values.workers) : undefined,
        onProgress: ({ stage, fraction }) =>
          process.stderr.write(`${stage} ${(fraction * 100).toFixed(0)}%\n`),
      });
      print(result);
      return 0;
    }
    case "probe": {
      print({ ...(await probeMedia(target)), ...(await sha256File(target)) });
      return 0;
    }
    default:
      process.stderr.write(`Unknown command: ${command}\n\n${USAGE}`);
      return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
