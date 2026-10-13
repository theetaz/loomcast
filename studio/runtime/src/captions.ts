import type { AlignedWord } from "@loomcast/contracts";

// Turns word timings into on-screen caption chunks. A chunk has at most two lines; a line holds
// at most three words and eighteen characters (a longer single word gets a line of its own).
// Chunks break at sentence ends and pauses, and stay on screen for at least 0.6 s.

export interface CaptionOptions {
  maxWordsPerLine?: number;
  maxCharsPerLine?: number;
  maxLines?: number;
  /** The shortest time a chunk stays on screen. */
  minDurationMs?: number;
  /** A silence at least this long starts a new chunk. */
  pauseBreakMs?: number;
  /** Gaps up to this long are closed by holding the previous chunk, so captions don't flicker. */
  bridgeGapMs?: number;
}

export interface CaptionWord {
  text: string;
  startMs: number;
  endMs: number;
  /** The line of the chunk the word is on, from 0. */
  line: number;
}

export interface CaptionChunk {
  startMs: number;
  endMs: number;
  lines: string[];
  /** The chunk's words with their timings, for word-by-word highlighting. */
  words: CaptionWord[];
}

export const CAPTION_DEFAULTS: Required<CaptionOptions> = {
  maxWordsPerLine: 3,
  maxCharsPerLine: 18,
  maxLines: 2,
  minDurationMs: 600,
  pauseBreakMs: 500,
  bridgeGapMs: 300,
};

const SENTENCE_END = /[.!?…]["')\]]*$/;

interface Draft {
  lines: AlignedWord[][];
  startMs: number;
  endMs: number;
}

function lineFits(line: AlignedWord[], word: string, options: Required<CaptionOptions>): boolean {
  if (line.length === 0) return true;
  if (line.length + 1 > options.maxWordsPerLine) return false;
  return [...line.map((w) => w.text), word].join(" ").length <= options.maxCharsPerLine;
}

/** Groups words into chunks of at most `maxLines` lines. */
function draftChunks(words: AlignedWord[], options: Required<CaptionOptions>): Draft[] {
  const drafts: Draft[] = [];
  let current: Draft | undefined;
  let previous: AlignedWord | undefined;

  for (const word of words) {
    const text = word.text.trim().replace(/\s+/g, " ");
    if (text === "") continue;

    const breakBefore =
      current !== undefined &&
      previous !== undefined &&
      (word.startMs - previous.endMs >= options.pauseBreakMs ||
        SENTENCE_END.test(previous.text.trim()));

    const entry = { text, startMs: word.startMs, endMs: word.endMs };
    if (!current || breakBefore) {
      current = { lines: [[entry]], startMs: word.startMs, endMs: word.endMs };
      drafts.push(current);
    } else {
      const line = current.lines.at(-1) ?? [];
      if (lineFits(line, text, options)) {
        line.push(entry);
      } else if (current.lines.length < options.maxLines) {
        current.lines.push([entry]);
      } else {
        current = { lines: [[entry]], startMs: word.startMs, endMs: word.endMs };
        drafts.push(current);
      }
      current.endMs = Math.max(current.endMs, word.endMs);
    }
    previous = word;
  }
  return drafts;
}

/** Turns word timings into timed caption chunks that never overlap. */
export function chunkCaptions(
  words: readonly AlignedWord[],
  options: CaptionOptions = {},
): CaptionChunk[] {
  const settings = { ...CAPTION_DEFAULTS, ...options };
  const drafts = draftChunks([...words], settings);

  const chunks: CaptionChunk[] = [];
  let previousEnd = 0;
  for (const draft of drafts) {
    const startMs = Math.round(Math.max(draft.startMs, previousEnd));
    const endMs = Math.round(Math.max(draft.endMs, startMs + settings.minDurationMs));
    chunks.push({
      startMs,
      endMs,
      lines: draft.lines.map((line) => line.map((word) => word.text).join(" ")),
      words: draft.lines.flatMap((line, index) =>
        line.map((word) => {
          const wordStart = Math.round(Math.min(Math.max(word.startMs, startMs), endMs));
          return {
            text: word.text,
            startMs: wordStart,
            endMs: Math.round(Math.min(Math.max(word.endMs, wordStart), endMs)),
            line: index,
          };
        }),
      ),
    });
    previousEnd = endMs;
  }

  chunks.forEach((chunk, index) => {
    const next = chunks[index + 1];
    if (next && next.startMs - chunk.endMs <= settings.bridgeGapMs) chunk.endMs = next.startMs;
  });
  return chunks;
}
