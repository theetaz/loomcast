import { MAX_TRANSCRIPT_LENGTH } from "@loomcast/contracts";

/**
 * Transcript files the user supplies, parsed in the browser into `[mm:ss] text` lines. Nothing is
 * fetched: Loomcast never downloads a video or its captions.
 */
export const TRANSCRIPT_FILE_EXTENSIONS = [".txt", ".srt", ".vtt", ".json"] as const;

/** Larger files are refused before they are read. */
export const MAX_TRANSCRIPT_FILE_BYTES = 5 * 1024 * 1024;

export type TranscriptParseResult =
  | { ok: true; text: string; lines: number }
  | { ok: false; error: string };

/** `[mm:ss]`, with minutes counting past 59 for long videos (`[75:03]`). */
export function formatTimestamp(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `[${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}]`;
}

const TIMECODE_RE = /^(?:(\d+):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?$/;

/** `01:02:03,500`, `02:03.500` or `2:03` in milliseconds; null when it is not a timecode. */
export function parseTimecode(value: string): number | null {
  const match = TIMECODE_RE.exec(value.trim());
  if (!match) return null;
  const [, hours = "0", minutes = "0", seconds = "0", fraction = "0"] = match;
  return (
    Number(hours) * 3_600_000 +
    Number(minutes) * 60_000 +
    Number(seconds) * 1_000 +
    Number(fraction.padEnd(3, "0"))
  );
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  "#39": "'",
};

/**
 * Caption text without markup: tags such as `<i>`, `<c.color>` and `<00:00:01.000>`, SSA
 * overrides such as `{\an8}`, and the common entities. The result is only ever shown as text.
 */
export function cleanCueText(text: string): string {
  return text
    .replace(/<[^>]*>/g, "")
    .replace(/\{\\[^}]*\}/g, "")
    .replace(/&(amp|lt|gt|quot|apos|nbsp|#39);/g, (_match, name: string) => ENTITIES[name] ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Removes what a transcript may not contain: C0 control characters other than tab, line feed and
 * carriage return, and lone surrogates.
 */
export function sanitizeTranscript(text: string): string {
  let result = "";
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) continue;
    if (code === 0x7f) continue;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        result += text.slice(index, index + 2);
        index += 1;
      }
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) continue;
    result += text.charAt(index);
  }
  return result;
}

function normalizeNewlines(text: string): string {
  return text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
}

interface Cue {
  startMs: number;
  lines: string[];
}

/** Cues of an SRT or WebVTT file: a timing line with `-->`, then the text lines. */
function readCues(text: string): Cue[] {
  const cues: Cue[] = [];
  for (const block of normalizeNewlines(text).split(/\n[ \t]*\n/)) {
    const lines = block.split("\n");
    const timing = lines.findIndex((line) => line.includes("-->"));
    if (timing < 0) continue;
    const start = parseTimecode(lines[timing]?.split("-->")[0] ?? "");
    if (start === null) continue;
    const textLines = lines
      .slice(timing + 1)
      .map(cleanCueText)
      .filter((line) => line.length > 0);
    if (textLines.length > 0) cues.push({ startMs: start, lines: textLines });
  }
  return cues;
}

/**
 * Turns cues into `[mm:ss] text` lines. Captions that roll up repeat the previous line at the top
 * of the next cue, so a line equal to the one before it is dropped.
 */
function cuesToLines(cues: Cue[], joinCueLines: boolean): string[] {
  const out: string[] = [];
  let previous = "";
  for (const cue of cues) {
    const texts = joinCueLines ? [cue.lines.join(" ")] : cue.lines;
    for (const line of texts) {
      if (line === previous) continue;
      out.push(`${formatTimestamp(cue.startMs)} ${line}`);
      previous = line;
    }
  }
  return out;
}

/** SubRip: numbered cues, `00:00:01,000 --> 00:00:03,000` timings. */
export function parseSrt(text: string): string[] {
  return cuesToLines(readCues(text), true);
}

/** WebVTT: the `WEBVTT` header and `NOTE`, `STYLE` and `REGION` blocks are skipped. */
export function parseVtt(text: string): string[] {
  const body = normalizeNewlines(text)
    .split(/\n[ \t]*\n/)
    .filter((block) => !/^(WEBVTT|NOTE|STYLE|REGION)\b/.test(block.trimStart()))
    .join("\n\n");
  return cuesToLines(readCues(body), false);
}

interface TimedWord {
  text: string;
  startMs: number | null;
}

const TEXT_KEYS = ["word", "text", "w", "token"] as const;
const SECOND_KEYS = ["start", "start_time", "startTime", "from", "ts", "offset"] as const;
const MS_KEYS = ["startMs", "start_ms", "startMillis", "offsetMs"] as const;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readWord(value: unknown, secondsAreMs: boolean): TimedWord | null {
  if (typeof value === "string") return { text: value, startMs: null };
  const item = record(value);
  if (!item) return null;
  const text = TEXT_KEYS.map((key) => item[key]).find((field) => typeof field === "string");
  if (typeof text !== "string") return null;
  const ms = MS_KEYS.map((key) => item[key]).find((field) => typeof field === "number");
  if (typeof ms === "number") return { text, startMs: ms };
  const seconds = SECOND_KEYS.map((key) => item[key]).find((field) => typeof field === "number");
  if (typeof seconds === "number") {
    return { text, startMs: secondsAreMs ? seconds : Math.round(seconds * 1000) };
  }
  return { text, startMs: null };
}

/** Times above ten hours read as seconds are taken to be milliseconds already. */
function looksLikeMilliseconds(items: unknown[]): boolean {
  return items.some((value) => {
    const item = record(value);
    return typeof item?.start === "number" && item.start > 36_000;
  });
}

/** A line ends at a sentence end (after four words) or after twelve words. */
const WORDS_PER_LINE = 12;
const MIN_WORDS_BEFORE_BREAK = 4;

function wordsToLines(words: TimedWord[]): string[] {
  const out: string[] = [];
  let line: string[] = [];
  let lineStart: number | null = null;
  const flush = () => {
    if (line.length === 0) return;
    const text = line.join(" ").replace(/\s+([,.;:!?])/g, "$1");
    out.push(lineStart === null ? text : `${formatTimestamp(lineStart)} ${text}`);
    line = [];
    lineStart = null;
  };
  for (const word of words) {
    const text = cleanCueText(word.text);
    if (!text) continue;
    if (line.length === 0) lineStart = word.startMs;
    line.push(text);
    const sentenceEnd = /[.!?]["')\]]?$/.test(text);
    if (line.length >= WORDS_PER_LINE || (sentenceEnd && line.length >= MIN_WORDS_BEFORE_BREAK)) {
      flush();
    }
  }
  flush();
  return out;
}

/**
 * A JSON transcript: a word list (`[{word, start}]`, or `{words: [...]}`) or timed segments
 * (`{segments: [{start, text}]}`). `start` is in seconds, `startMs` in milliseconds.
 */
export function parseWordListJson(json: unknown): string[] {
  const root = record(json);
  const segments = Array.isArray(root?.segments) ? root.segments : null;
  if (segments) {
    const asMs = looksLikeMilliseconds(segments);
    const out: string[] = [];
    for (const segment of segments) {
      const nested = record(segment)?.words;
      if (Array.isArray(nested) && nested.length > 0) {
        const nestedMs = looksLikeMilliseconds(nested);
        out.push(...wordsToLines(nested.flatMap((word) => readWord(word, nestedMs) ?? [])));
        continue;
      }
      const word = readWord(segment, asMs);
      if (!word) continue;
      const text = cleanCueText(word.text);
      if (text) out.push(word.startMs === null ? text : `${formatTimestamp(word.startMs)} ${text}`);
    }
    return out;
  }
  const words = Array.isArray(json) ? json : Array.isArray(root?.words) ? root.words : null;
  if (!words) return [];
  const asMs = looksLikeMilliseconds(words);
  return wordsToLines(words.flatMap((word) => readWord(word, asMs) ?? []));
}

/** Plain text: line endings normalised, lines trimmed, runs of blank lines collapsed. */
export function parsePlainText(text: string): string[] {
  return normalizeNewlines(text)
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .split("\n");
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot).toLowerCase();
}

export function isTranscriptFileName(name: string): boolean {
  return (TRANSCRIPT_FILE_EXTENSIONS as readonly string[]).includes(extensionOf(name));
}

/** Checks what parsing produced: something to save, and no more than the API accepts. */
export function finishTranscript(lines: string[], source: string): TranscriptParseResult {
  const text = sanitizeTranscript(lines.join("\n")).trim();
  if (!text) return { ok: false, error: `No transcript text was found in ${source}.` };
  if (text.length > MAX_TRANSCRIPT_LENGTH) {
    return {
      ok: false,
      error: `The transcript is longer than ${MAX_TRANSCRIPT_LENGTH.toLocaleString("en")} characters. Trim it and try again.`,
    };
  }
  return { ok: true, text, lines: text.split("\n").length };
}

/** Parses a transcript file by its extension: `.txt`, `.srt`, `.vtt` or a `.json` word list. */
export function parseTranscriptFile(name: string, content: string): TranscriptParseResult {
  switch (extensionOf(name)) {
    case ".srt":
      return finishTranscript(parseSrt(content), name);
    case ".vtt":
      return finishTranscript(parseVtt(content), name);
    case ".json": {
      let json: unknown;
      try {
        json = JSON.parse(content);
      } catch {
        return { ok: false, error: `${name} is not valid JSON.` };
      }
      return finishTranscript(parseWordListJson(json), name);
    }
    case ".txt":
      return finishTranscript(parsePlainText(content), name);
    default:
      return { ok: false, error: "Load a .txt, .srt, .vtt or .json transcript." };
  }
}
