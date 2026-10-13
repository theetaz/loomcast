import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { VoiceAlignment } from "@loomcast/contracts";
import { type CaptionChunk, type CaptionOptions, chunkCaptions } from "./captions.ts";
import { mountCard } from "./card.ts";
import { escapeHtml, guardRawText, secondsAttr } from "./html.ts";
import { studioPaths } from "./paths.ts";
import { type CardRegistry, loadRegistry } from "./registry.ts";
import { parseStoryboard, type StoryboardIssue, validateStoryboard } from "./storyboard.ts";

// Builds a HyperFrames project for one content version at `<itemDir>/render/`: the vertical shell
// (index.html), one sub-composition per storyboard frame, captions from the voice timings, the
// voice as the audio track, and the assets the render needs locally (GSAP, style tokens).

export const SHORT_WIDTH = 1080;
export const SHORT_HEIGHT = 1920;
export const SHORT_FPS = 30;
export const SHORT_COMPOSITION_ID = "loomcast-short";

/** The card area of the shell, in frame pixels (see templates/vertical-shell/shell.css). */
const CARD_AREA = { top: 660, height: 608 };

export interface AssembleOptions {
  /** The content version's workspace; the project is written to `<itemDir>/render/`. */
  itemDir: string;
  /** The storyboard to render; validated against the registry first. */
  storyboard: unknown;
  /** The voice take (MP3), copied into the project as its audio track. */
  voicePath: string;
  /** The voice take's length, which is the length of the video. */
  voiceDurationMs: number;
  /** Word timings of the voice take; without them the video has no captions. */
  alignment?: VoiceAlignment;
  /** The line shown in the hook band, usually the script's hook. */
  hook?: string;
  /** The project title, recorded in meta.json and the page title. */
  title?: string;
  captions?: CaptionOptions;
  registry?: CardRegistry;
  studioRoot?: string;
  /** Creation time recorded in meta.json. */
  now?: Date;
}

export interface AssembledFrame {
  frameId: string;
  cardId: string;
  compositionId: string;
  /** The sub-composition, relative to the render directory. */
  file: string;
  layout: "landscape" | "vertical";
  startMs: number;
  endMs: number;
}

export interface AssembleResult {
  renderDir: string;
  indexPath: string;
  durationMs: number;
  frames: AssembledFrame[];
  captions: CaptionChunk[];
  /** Storyboard warnings, such as unfilled slots. */
  warnings: StoryboardIssue[];
}

/** Hook text size: long hooks get smaller type so they fit four lines of the band. */
export function hookFontSize(text: string): number {
  const length = text.trim().length;
  if (length <= 40) return 80;
  if (length <= 80) return 66;
  if (length <= 140) return 54;
  return 44;
}

/** Strips `@import` rules so the render never fetches fonts or styles from the network. */
export function localTokens(css: string): string {
  return css
    .replace(/@import\s+url\(\s*(["'])[^"']*\1\s*\)[^;]*;/g, "")
    .replace(/@import\s+(["'])[^"']*\1[^;]*;/g, "")
    .replace(/@import\s+url\([^)"']*\)[^;]*;/g, "");
}

function fillTemplate(template: string, values: Record<string, string>): string {
  // One pass, so text substituted for one placeholder can never be expanded as another.
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (match, key: string) => values[key] ?? match);
}

function px(value: number): string {
  return `${Math.round(value * 1000) / 1000}px`;
}

/** Placement of a mounted card: landscape cards fit the card area, 9:16 cards the whole frame. */
function placement(
  width: number,
  height: number,
): { layout: AssembledFrame["layout"]; style: string } {
  if (height > width) {
    const scale = Math.min(SHORT_WIDTH / width, SHORT_HEIGHT / height);
    const left = (SHORT_WIDTH - width * scale) / 2;
    const top = (SHORT_HEIGHT - height * scale) / 2;
    return {
      layout: "vertical",
      style: `left: ${px(left)}; top: ${px(top)}; width: ${width}px; height: ${height}px; transform: scale(${scale}); transform-origin: 0 0`,
    };
  }
  const scale = Math.min(SHORT_WIDTH / width, CARD_AREA.height / height);
  const left = (SHORT_WIDTH - width * scale) / 2;
  const top = CARD_AREA.top + (CARD_AREA.height - height * scale) / 2;
  return {
    layout: "landscape",
    style: `left: ${px(left)}; top: ${px(top)}; width: ${width}px; height: ${height}px; transform: scale(${scale}); transform-origin: 0 0`,
  };
}

function captionMarkup(chunks: CaptionChunk[]): string {
  return chunks
    .map((chunk, index) => {
      const id = `lc-cap-${String(index + 1).padStart(3, "0")}`;
      const lines = chunk.lines
        .map((line) => `<span class="lc-caption-line">${escapeHtml(line)}</span>`)
        .join("");
      return [
        `      <div id="${id}" class="clip lc-caption" data-start="${secondsAttr(chunk.startMs)}"`,
        `        data-duration="${secondsAttr(chunk.endMs - chunk.startMs)}" data-track-index="2">`,
        `        <div class="lc-caption-inner">${lines}</div>`,
        "      </div>",
      ].join("\n");
    })
    .join("\n");
}

/** Builds the HyperFrames project for one content version. */
export async function assembleProject(options: AssembleOptions): Promise<AssembleResult> {
  if (!Number.isFinite(options.voiceDurationMs) || options.voiceDurationMs <= 0) {
    throw new Error("The voice duration must be a positive number of milliseconds");
  }
  const paths = studioPaths(options.studioRoot);
  const registry = options.registry ?? loadRegistry({ studioRoot: paths.root });
  const durationMs = Math.round(options.voiceDurationMs);
  const storyboard = parseStoryboard(options.storyboard, registry, { voiceDurationMs: durationMs });
  const warnings = validateStoryboard(storyboard, registry, { voiceDurationMs: durationMs }).filter(
    (issue) => issue.severity === "warning",
  );
  const style = registry.getStyle(storyboard.styleId);
  if (!style) throw new Error(`Style ${storyboard.styleId} is not in the style library`);

  const renderDir = join(options.itemDir, "render");
  const assets = join(renderDir, "assets");
  const compositions = join(renderDir, "compositions");
  await rm(renderDir, { recursive: true, force: true });
  await mkdir(assets, { recursive: true });
  await mkdir(compositions, { recursive: true });

  const shell = paths.shellTemplate;
  await copyFile(paths.gsap, join(assets, "gsap.min.js")).catch((error: unknown) => {
    throw new Error(
      `GSAP is missing from the studio workspace; run pnpm install (${String(error)})`,
    );
  });
  await copyFile(join(shell, "shell.css"), join(assets, "shell.css"));
  await writeFile(join(assets, "tokens.css"), localTokens(await readFile(style.tokens, "utf8")));
  await copyFile(options.voicePath, join(assets, "voice.mp3"));

  const frames: AssembledFrame[] = [];
  const hosts: string[] = [];
  for (const frame of storyboard.frames) {
    const card = registry.getCard(frame.cardId);
    if (!card) throw new Error(`Card ${frame.cardId} is not in the style library`);
    const mounted = mountCard({
      html: await readFile(card.file, "utf8"),
      compositionId: `lc-${frame.id}`,
      slots: card.slots,
      values: frame.slots,
    });
    const file = `compositions/${frame.id}.html`;
    await writeFile(join(renderDir, file), mounted.html);

    const endMs = Math.min(frame.endMs, durationMs);
    const { layout, style: inline } = placement(mounted.width, mounted.height);
    frames.push({
      frameId: frame.id,
      cardId: card.id,
      compositionId: mounted.compositionId,
      file,
      layout,
      startMs: frame.startMs,
      endMs,
    });
    if (endMs <= frame.startMs) continue;
    hosts.push(
      [
        `      <div id="${mounted.compositionId}-host" class="lc-card lc-card--${layout}"`,
        `        data-composition-id="${mounted.compositionId}" data-composition-src="${file}"`,
        `        data-start="${secondsAttr(frame.startMs)}" data-duration="${secondsAttr(endMs - frame.startMs)}"`,
        `        data-track-index="1" data-width="${mounted.width}" data-height="${mounted.height}"`,
        `        style="${inline}"></div>`,
      ].join("\n"),
    );
  }

  const captions = (
    options.alignment ? chunkCaptions(options.alignment.words, options.captions) : []
  )
    .filter((chunk) => chunk.startMs < durationMs)
    .map((chunk) => ({ ...chunk, endMs: Math.min(chunk.endMs, durationMs) }));

  const hook = options.hook ?? options.title ?? "";
  const title = options.title ?? "Loomcast short";
  const index = fillTemplate(await readFile(join(shell, "index.html"), "utf8"), {
    TITLE: escapeHtml(title),
    DURATION: secondsAttr(durationMs),
    HOOK_SIZE: String(hookFontSize(hook)),
    HOOK: escapeHtml(hook),
    GLYPH: (await readFile(join(shell, "glyph.svg"), "utf8")).trim(),
    CARDS: hosts.join("\n"),
    CAPTIONS: captionMarkup(captions),
    SHELL_SCRIPT: `    <script>\n${guardRawText(await readFile(join(shell, "shell.js"), "utf8"))}    </script>`,
  });
  const indexPath = join(renderDir, "index.html");
  await writeFile(indexPath, index);

  await writeFile(
    join(renderDir, "hyperframes.json"),
    `${JSON.stringify(
      {
        $schema: "https://hyperframes.heygen.com/schema/hyperframes.json",
        paths: { blocks: "compositions", components: "compositions/components", assets: "assets" },
        media: { autoProxy: false },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(renderDir, "meta.json"),
    `${JSON.stringify(
      {
        id: SHORT_COMPOSITION_ID,
        name: title,
        createdAt: (options.now ?? new Date()).toISOString(),
        width: SHORT_WIDTH,
        height: SHORT_HEIGHT,
        fps: SHORT_FPS,
        durationMs,
        styleId: storyboard.styleId,
        frames: frames.map(({ frameId, cardId, layout }) => ({ frameId, cardId, layout })),
      },
      null,
      2,
    )}\n`,
  );

  return { renderDir, indexPath, durationMs, frames, captions, warnings };
}
