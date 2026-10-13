import { openAsBlob } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { ALIGNED_WORD_MAX_LENGTH, type AlignedWord } from "@loomcast/contracts";
import {
  describeFailure,
  type FetchLike,
  fetchWithRetry,
  isRetryableStatus,
  ProviderError,
  type RetryOptions,
} from "./http.ts";
import { type CommandRunner, runChecked, runCommand } from "./process.ts";
import { TTS_BASE_URL } from "./voice.ts";

// Word-level transcription of reference media the owner supplied, ported from the existing
// transcription helper in scripts/: video inputs are reduced to mono 16 kHz MP3 with ffmpeg, the
// audio is uploaded to the provider's speech-to-text endpoint (POST /v1/speech-to-text, checked
// 2026-10-13) with the same key as voice synthesis, and the temporary audio is removed.

export const STT_DEFAULT_MODEL = "scribe_v2";

const AUDIO_EXTENSIONS = new Set([
  ".mp3",
  ".wav",
  ".flac",
  ".m4a",
  ".aac",
  ".ogg",
  ".opus",
  ".webm",
]);

export interface TranscribeOptions {
  apiKey: string;
  inputPath: string;
  modelId?: string;
  /** ISO 639 language code; omit to let the provider detect it. */
  languageCode?: string;
  diarize?: boolean;
  tagAudioEvents?: boolean;
  baseUrl?: string;
  fetch?: FetchLike;
  retry?: RetryOptions;
  ffmpegPath?: string;
  run?: CommandRunner;
  signal?: AbortSignal;
}

export interface Transcript {
  text: string;
  languageCode?: string;
  durationMs?: number;
  /** Spoken words only (no spacing or audio events). */
  words: AlignedWord[];
}

interface ProviderWord {
  text?: string;
  type?: string;
  start?: number | null;
  end?: number | null;
}

interface ProviderTranscript {
  text?: string;
  language_code?: string;
  audio_duration_secs?: number;
  words?: ProviderWord[];
}

/** The ffmpeg arguments that extract mono 16 kHz speech audio from a video. */
export function extractAudioArgs(inputPath: string, outputPath: string): string[] {
  return [
    "-y",
    "-v",
    "error",
    "-i",
    inputPath,
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-c:a",
    "libmp3lame",
    "-b:a",
    "64k",
    outputPath,
  ];
}

/** Maps the provider's response to word timings in milliseconds. */
export function parseTranscript(json: ProviderTranscript): Transcript {
  const words: AlignedWord[] = [];
  for (const word of json.words ?? []) {
    if (word.type !== undefined && word.type !== "word") continue;
    const text = word.text?.trim();
    if (!text || typeof word.start !== "number") continue;
    const startMs = Math.round(word.start * 1000);
    const endMs = Math.max(Math.round((word.end ?? word.start) * 1000), startMs);
    words.push({ text: text.slice(0, ALIGNED_WORD_MAX_LENGTH), startMs, endMs });
  }
  return {
    text: json.text ?? words.map((word) => word.text).join(" "),
    ...(json.language_code ? { languageCode: json.language_code } : {}),
    ...(typeof json.audio_duration_secs === "number"
      ? { durationMs: Math.round(json.audio_duration_secs * 1000) }
      : {}),
    words,
  };
}

/** Transcribes an audio or video file to word timings. */
export async function transcribeMedia(options: TranscribeOptions): Promise<Transcript> {
  if (!options.apiKey) throw new Error("The transcription provider key is not configured");
  const isAudio = AUDIO_EXTENSIONS.has(extname(options.inputPath).toLowerCase());
  const workDir = isAudio ? undefined : await mkdtemp(join(tmpdir(), "loomcast-transcribe-"));
  try {
    let uploadPath = options.inputPath;
    if (workDir) {
      uploadPath = join(workDir, "audio.mp3");
      await runChecked(
        options.run ?? runCommand,
        "ffmpeg audio extraction",
        options.ffmpegPath ?? "ffmpeg",
        extractAudioArgs(options.inputPath, uploadPath),
        { signal: options.signal },
      );
    }

    const blob = await openAsBlob(uploadPath);
    const makeBody = () => {
      const form = new FormData();
      form.append("file", blob, basename(uploadPath));
      form.append("model_id", options.modelId ?? STT_DEFAULT_MODEL);
      form.append("timestamps_granularity", "word");
      if (options.languageCode) form.append("language_code", options.languageCode);
      form.append("diarize", String(options.diarize ?? true));
      form.append("tag_audio_events", String(options.tagAudioEvents ?? false));
      return form;
    };
    const fetchImpl = options.fetch ?? fetch;
    const response = await fetchWithRetry(
      // A FormData body is consumed per request, so each attempt builds a fresh one.
      (url, init) => fetchImpl(url, { ...init, body: makeBody() }),
      `${options.baseUrl ?? TTS_BASE_URL}/v1/speech-to-text`,
      {
        method: "POST",
        headers: { "xi-api-key": options.apiKey, accept: "application/json" },
        signal: options.signal,
      },
      options.retry,
    );
    if (!response.ok) {
      throw new ProviderError(
        `The transcription provider rejected the request (${await describeFailure(response)})`,
        response.status,
        isRetryableStatus(response.status),
      );
    }
    return parseTranscript((await response.json()) as ProviderTranscript);
  } finally {
    if (workDir) await rm(workDir, { recursive: true, force: true });
  }
}
