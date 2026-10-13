import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  ALIGNED_WORD_MAX_LENGTH,
  type AlignedWord,
  type VoiceAlignment,
  VoiceAlignmentSchema,
} from "@loomcast/contracts";
import {
  describeFailure,
  type FetchLike,
  fetchWithRetry,
  isRetryableStatus,
  ProviderError,
  type RetryOptions,
} from "./http.ts";
import { studioPaths } from "./paths.ts";
import { type MediaProbe, probeMedia } from "./probe.ts";
import { type CommandRunner, runChecked, runCommand } from "./process.ts";

// Voice synthesis through the TTS provider's "with timestamps" endpoint
// (POST /v1/text-to-speech/{voice_id}/with-timestamps, checked against the provider's API
// reference on 2026-10-13). The script is sent in parts of at most 5,000 characters, split at
// segment boundaries; the parts are joined with ffmpeg and their timings offset by the measured
// length of the parts before them. The key comes from the caller and never appears in errors.

export const TTS_BASE_URL = "https://api.elevenlabs.io";
export const TTS_DEFAULT_MODEL = "eleven_multilingual_v2";
export const TTS_OUTPUT_FORMAT = "mp3_44100_128";
export const TTS_MAX_PART_CHARS = 5_000;
/** Context sent with each part so the voice keeps its flow across part boundaries. */
const CONTEXT_CHARS = 500;

/** The environment variables the TTS provider key is read from, in order. */
export const VOICE_KEY_VARS = ["ELEVENLABS_API_KEY", "ELEVEN_API_KEY", "XI_API_KEY"] as const;

export interface VoiceSegment {
  id: string;
  text: string;
}

export interface VoicePart {
  text: string;
  /** The segment each word of `text` belongs to, in order. */
  wordSegments: string[];
}

export interface SynthesizeVoiceOptions {
  apiKey: string;
  voiceId: string;
  segments: readonly VoiceSegment[];
  /** Where the joined MP3 is written. */
  outputPath: string;
  modelId?: string;
  /** Speaking rate; 1 is the voice's normal speed. */
  speed?: number;
  maxPartChars?: number;
  baseUrl?: string;
  fetch?: FetchLike;
  retry?: RetryOptions;
  ffmpegPath?: string;
  run?: CommandRunner;
  /** Measures a part or the result (injectable for tests). */
  probe?: (path: string) => Promise<MediaProbe>;
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
}

export interface SegmentTiming {
  id: string;
  startMs: number;
  endMs: number;
}

export interface SynthesizeVoiceResult {
  path: string;
  durationMs: number;
  alignment: VoiceAlignment;
  segments: SegmentTiming[];
  parts: number;
  characters: number;
}

interface ProviderAlignment {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
}

interface ProviderResponse {
  audio_base64?: string;
  alignment?: ProviderAlignment | null;
  normalized_alignment?: ProviderAlignment | null;
}

function words(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

/** Splits an over-long segment at sentence ends, then at word boundaries. */
function pieces(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let current = "";
  const push = (piece: string) => {
    if (!current) current = piece;
    else if (current.length + 1 + piece.length <= max) current = `${current} ${piece}`;
    else {
      out.push(current);
      current = piece;
    }
  };
  for (const sentence of text.split(/(?<=[.!?…])\s+/)) {
    if (sentence.length <= max) push(sentence);
    else for (const word of words(sentence)) push(word.slice(0, max));
  }
  if (current) out.push(current);
  return out;
}

/**
 * Groups segments into parts of at most `max` characters. A part never splits a segment unless
 * the segment alone is longer than `max`.
 */
export function splitForSynthesis(
  segments: readonly VoiceSegment[],
  max = TTS_MAX_PART_CHARS,
): VoicePart[] {
  const parts: VoicePart[] = [];
  let current: VoicePart | undefined;
  for (const segment of segments) {
    const text = segment.text.trim().replace(/\s+/g, " ");
    if (!text) continue;
    for (const piece of pieces(text, max)) {
      const owners = words(piece).map(() => segment.id);
      if (current && current.text.length + 1 + piece.length <= max) {
        current.text = `${current.text} ${piece}`;
        current.wordSegments.push(...owners);
      } else {
        current = { text: piece, wordSegments: owners };
        parts.push(current);
      }
    }
  }
  return parts;
}

/** Turns per-character timings into word timings; whitespace separates words. */
export function charactersToWords(alignment: ProviderAlignment, offsetMs = 0): AlignedWord[] {
  const result: AlignedWord[] = [];
  let text = "";
  let start = 0;
  let end = 0;
  const flush = () => {
    if (!text) return;
    result.push({
      text: text.slice(0, ALIGNED_WORD_MAX_LENGTH),
      startMs: Math.round(start * 1000) + offsetMs,
      endMs: Math.max(Math.round(end * 1000), Math.round(start * 1000)) + offsetMs,
    });
    text = "";
  };
  alignment.characters.forEach((char, index) => {
    if (/\s/.test(char)) {
      flush();
      return;
    }
    if (!text) start = alignment.character_start_times_seconds[index] ?? end;
    text += char;
    end = alignment.character_end_times_seconds[index] ?? start;
  });
  flush();
  return result;
}

/** Reads the TTS provider key from the environment, then from the studio's `.env`. */
export function readVoiceProviderKey(
  options: { env?: Readonly<Record<string, string | undefined>>; envFile?: string } = {},
): string | undefined {
  const env = options.env ?? process.env;
  for (const name of VOICE_KEY_VARS) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  const file = options.envFile ?? join(studioPaths().root, ".env");
  if (!existsSync(file)) return undefined;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = /^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (match && (VOICE_KEY_VARS as readonly string[]).includes(match[1] ?? "")) {
      const value = (match[2] ?? "").replace(/^["']|["']$/g, "");
      if (value) return value;
    }
  }
  return undefined;
}

async function synthesizePart(
  options: SynthesizeVoiceOptions,
  part: VoicePart,
  context: { previous?: string; next?: string },
): Promise<{ audio: Buffer; alignment: ProviderAlignment }> {
  const url = `${options.baseUrl ?? TTS_BASE_URL}/v1/text-to-speech/${encodeURIComponent(
    options.voiceId,
  )}/with-timestamps?output_format=${TTS_OUTPUT_FORMAT}`;
  const body = {
    text: part.text,
    model_id: options.modelId ?? TTS_DEFAULT_MODEL,
    ...(options.speed !== undefined ? { voice_settings: { speed: options.speed } } : {}),
    ...(context.previous ? { previous_text: context.previous } : {}),
    ...(context.next ? { next_text: context.next } : {}),
  };
  const response = await fetchWithRetry(
    options.fetch ?? fetch,
    url,
    {
      method: "POST",
      headers: {
        "xi-api-key": options.apiKey,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(body),
      signal: options.signal,
    },
    options.retry,
  );
  if (!response.ok) {
    throw new ProviderError(
      `The TTS provider rejected the request (${await describeFailure(response)})`,
      response.status,
      isRetryableStatus(response.status),
    );
  }
  const json = (await response.json()) as ProviderResponse;
  const alignment = json.alignment ?? json.normalized_alignment;
  if (!json.audio_base64 || !alignment) {
    throw new ProviderError(
      "The TTS provider returned no audio or timings",
      response.status,
      false,
    );
  }
  return { audio: Buffer.from(json.audio_base64, "base64"), alignment };
}

/** Synthesizes a script's segments into one MP3 with word and segment timings. */
export async function synthesizeVoice(
  options: SynthesizeVoiceOptions,
): Promise<SynthesizeVoiceResult> {
  if (!options.apiKey) throw new Error("The TTS provider key is not configured");
  if (!options.voiceId.trim()) throw new Error("No voice is configured for this format");
  const parts = splitForSynthesis(options.segments, options.maxPartChars);
  if (parts.length === 0) throw new Error("The script has no text to speak");

  const run = options.run ?? runCommand;
  const probe =
    options.probe ?? ((path: string) => probeMedia(path, { run, signal: options.signal }));
  await mkdir(dirname(options.outputPath), { recursive: true });
  const workDir = await mkdtemp(join(dirname(options.outputPath), ".voice-parts-"));

  try {
    const files: string[] = [];
    const allWords: AlignedWord[] = [];
    const owners: string[] = [];
    let offsetMs = 0;
    for (const [index, part] of parts.entries()) {
      const { audio, alignment } = await synthesizePart(options, part, {
        previous: parts[index - 1]?.text.slice(-CONTEXT_CHARS),
        next: parts[index + 1]?.text.slice(0, CONTEXT_CHARS),
      });
      const file = join(workDir, `part-${String(index).padStart(3, "0")}.mp3`);
      await writeFile(file, audio);
      files.push(file);

      const partWords = charactersToWords(alignment, offsetMs);
      partWords.forEach((_, wordIndex) => {
        const owner =
          part.wordSegments.length === partWords.length
            ? part.wordSegments[wordIndex]
            : part.wordSegments[
                Math.floor((wordIndex * part.wordSegments.length) / partWords.length)
              ];
        owners.push(owner ?? part.wordSegments.at(-1) ?? "");
      });
      allWords.push(...partWords);
      offsetMs += (await probe(file)).durationMs;
      options.onProgress?.((index + 1) / (parts.length + 1));
    }

    if (files.length === 1 && files[0]) {
      await copyFile(files[0], options.outputPath);
    } else {
      const inputs = files.flatMap((file) => ["-i", file]);
      const filter = `${files.map((_, i) => `[${i}:a]`).join("")}concat=n=${files.length}:v=0:a=1[voice]`;
      await runChecked(
        run,
        "ffmpeg concat",
        options.ffmpegPath ?? "ffmpeg",
        [
          "-y",
          "-v",
          "error",
          ...inputs,
          "-filter_complex",
          filter,
          "-map",
          "[voice]",
          "-c:a",
          "libmp3lame",
          "-b:a",
          "128k",
          "-ar",
          "44100",
          options.outputPath,
        ],
        { signal: options.signal },
      );
    }

    const durationMs = (await probe(options.outputPath)).durationMs || offsetMs;
    // Keep words in order even if a part's first word starts before the previous part's last.
    let floor = 0;
    const ordered = allWords.map((word) => {
      const startMs = Math.max(word.startMs, floor);
      floor = startMs;
      return { ...word, startMs, endMs: Math.max(word.endMs, startMs) };
    });
    const alignment = VoiceAlignmentSchema.parse({ words: ordered });

    const timings = new Map<string, SegmentTiming>();
    ordered.forEach((word, index) => {
      const id = owners[index];
      if (!id) return;
      const timing = timings.get(id);
      if (!timing) timings.set(id, { id, startMs: word.startMs, endMs: word.endMs });
      else timing.endMs = Math.max(timing.endMs, word.endMs);
    });
    options.onProgress?.(1);
    return {
      path: options.outputPath,
      durationMs,
      alignment,
      segments: options.segments.flatMap((segment) => {
        const timing = timings.get(segment.id);
        return timing ? [timing] : [];
      }),
      parts: parts.length,
      characters: parts.reduce((total, part) => total + part.text.length, 0),
    };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
