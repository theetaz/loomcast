import { join } from "node:path";
import { type AssembleOptions, type AssembleResult, assembleProject } from "./assemble.ts";
import { probeMedia } from "./probe.ts";
import type { CommandRunner } from "./process.ts";
import {
  type RenderProgress,
  type RenderQuality,
  type RenderResult,
  type RenderStage,
  renderProject,
} from "./render.ts";

// The files of one content version in the studio agent's workspace
// (~/Loomcast/projects/<projectId>/items/<itemId>/v<n>/), and the one-call render of it.

export interface ItemLayout {
  dir: string;
  script: string;
  storyboard: string;
  voice: string;
  alignment: string;
  renderDir: string;
  output: string;
  poster: string;
}

export function itemLayout(itemDir: string): ItemLayout {
  return {
    dir: itemDir,
    script: join(itemDir, "script.json"),
    storyboard: join(itemDir, "storyboard.json"),
    voice: join(itemDir, "voice.mp3"),
    alignment: join(itemDir, "alignment.json"),
    renderDir: join(itemDir, "render"),
    output: join(itemDir, "out", "final.mp4"),
    poster: join(itemDir, "poster.jpg"),
  };
}

export type ItemStage = "assemble" | RenderStage;

export interface RenderItemOptions extends Omit<AssembleOptions, "voicePath" | "voiceDurationMs"> {
  /** Defaults to `<itemDir>/voice.mp3`. */
  voicePath?: string;
  /** Defaults to the measured length of the voice take. */
  voiceDurationMs?: number;
  quality?: RenderQuality;
  workers?: number;
  browserPath?: string;
  ffmpegPath?: string;
  ffprobePath?: string;
  run?: CommandRunner;
  signal?: AbortSignal;
  onProgress?: (progress: { stage: ItemStage; fraction: number }) => void;
}

export interface RenderItemResult {
  assembly: AssembleResult;
  render: RenderResult;
}

/** Assembles and renders one content version: `out/final.mp4` and `poster.jpg`. */
export async function renderItem(options: RenderItemOptions): Promise<RenderItemResult> {
  const layout = itemLayout(options.itemDir);
  const voicePath = options.voicePath ?? layout.voice;
  const voiceDurationMs =
    options.voiceDurationMs ??
    (
      await probeMedia(voicePath, {
        ffprobePath: options.ffprobePath,
        run: options.run,
        signal: options.signal,
      })
    ).durationMs;

  options.onProgress?.({ stage: "assemble", fraction: 0 });
  const assembly = await assembleProject({ ...options, voicePath, voiceDurationMs });
  const render = await renderProject({
    renderDir: assembly.renderDir,
    outputPath: layout.output,
    posterPath: layout.poster,
    voicePath,
    expectedDurationMs: assembly.durationMs,
    quality: options.quality,
    workers: options.workers,
    browserPath: options.browserPath,
    studioRoot: options.studioRoot,
    ffmpegPath: options.ffmpegPath,
    ffprobePath: options.ffprobePath,
    run: options.run,
    signal: options.signal,
    onProgress: (progress: RenderProgress) => options.onProgress?.(progress),
  });
  return { assembly, render };
}
