import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fetchWithRetry, ProviderError } from "../src/http.ts";
import { extractAudioArgs, parseTranscript, transcribeMedia } from "../src/transcribe.ts";
import {
  charactersToWords,
  readVoiceProviderKey,
  splitForSynthesis,
  synthesizeVoice,
  TTS_MAX_PART_CHARS,
} from "../src/voice.ts";
import { fakeRunner, mediaProbe, tempDir, testKey } from "./support.ts";

/** Provider timings for `text`: each character lasts 50 ms. */
function alignmentFor(text: string) {
  const characters = [...text];
  return {
    characters,
    character_start_times_seconds: characters.map((_, i) => i * 0.05),
    character_end_times_seconds: characters.map((_, i) => (i + 1) * 0.05),
  };
}

interface Captured {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** A fake provider that answers each request from `script`, recording what it was sent. */
function fakeProvider(script: ((captured: Captured) => Response)[]) {
  const requests: Captured[] = [];
  const fetchImpl = async (url: string, init: RequestInit) => {
    const captured = { url, init, body: JSON.parse(String(init.body ?? "{}")) };
    requests.push(captured);
    const next = script[Math.min(requests.length - 1, script.length - 1)];
    if (!next) throw new Error("no scripted response");
    return next(captured);
  };
  return { fetchImpl, requests };
}

function speak(captured: Captured): Response {
  const text = String(captured.body.text);
  return jsonResponse(200, {
    audio_base64: Buffer.from(`audio:${text.length}`).toString("base64"),
    alignment: alignmentFor(text),
  });
}

const noSleep = async () => undefined;

describe("splitForSynthesis", () => {
  it("groups whole segments into parts of at most 5,000 characters", () => {
    const segments = Array.from({ length: 12 }, (_, i) => ({
      id: `s${i + 1}`,
      text: `${"word ".repeat(199)}end${i}.`, // about 1,000 characters each
    }));
    const parts = splitForSynthesis(segments);
    expect(parts.length).toBeGreaterThan(2);
    for (const part of parts) expect(part.text.length).toBeLessThanOrEqual(TTS_MAX_PART_CHARS);
    // No segment is cut in two: every segment's words sit in exactly one part.
    for (const segment of segments) {
      const holders = parts.filter((part) => part.wordSegments.includes(segment.id));
      expect(holders).toHaveLength(1);
    }
    expect(parts.flatMap((part) => part.wordSegments)).toHaveLength(12 * 200);
  });

  it("splits a segment longer than a part at sentence ends", () => {
    const long = "This sentence is short. ".repeat(10).trim();
    const parts = splitForSynthesis([{ id: "s1", text: long }], 60);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part.text.length).toBeLessThanOrEqual(60);
      expect(part.text.endsWith(".")).toBe(true);
    }
  });

  it("normalises whitespace and skips empty segments", () => {
    expect(
      splitForSynthesis([
        { id: "a", text: "  hello \n world " },
        { id: "b", text: " " },
      ]),
    ).toEqual([{ text: "hello world", wordSegments: ["a", "a"] }]);
  });
});

describe("charactersToWords", () => {
  it("turns character timings into word timings with an offset", () => {
    expect(charactersToWords(alignmentFor("Hi there"), 1_000)).toEqual([
      { text: "Hi", startMs: 1_000, endMs: 1_100 },
      { text: "there", startMs: 1_150, endMs: 1_400 },
    ]);
  });
});

describe("synthesizeVoice", () => {
  it("synthesizes parts, joins them with ffmpeg and offsets their timings", async () => {
    const dir = await tempDir();
    const apiKey = testKey("tts");
    const { fetchImpl, requests } = fakeProvider([speak]);
    const { run, calls } = fakeRunner();
    const durations = [2_000, 2_500];
    let probes = 0;
    const result = await synthesizeVoice({
      apiKey,
      voiceId: "voice/one",
      segments: [
        { id: "s1", text: "First part words." },
        { id: "s2", text: "Second part words." },
      ],
      maxPartChars: 20,
      speed: 1.1,
      outputPath: join(dir, "voice.mp3"),
      fetch: fetchImpl,
      run,
      probe: async (path) =>
        mediaProbe(path.endsWith("voice.mp3") ? 4_600 : (durations[probes++] ?? 0)),
    });

    expect(requests).toHaveLength(2);
    const [first, second] = requests;
    expect(first?.url).toBe(
      "https://api.elevenlabs.io/v1/text-to-speech/voice%2Fone/with-timestamps?output_format=mp3_44100_128",
    );
    const headers = (first?.init.headers ?? {}) as Record<string, string>;
    expect(headers["xi-api-key"]).toBe(apiKey);
    expect(first?.body).toEqual({
      text: "First part words.",
      model_id: "eleven_multilingual_v2",
      voice_settings: { speed: 1.1 },
      next_text: "Second part words.",
    });
    expect(second?.body.previous_text).toBe("First part words.");

    // The second part's words start after the first part's measured length.
    expect(result.alignment.words.map((word) => [word.text, word.startMs])).toEqual([
      ["First", 0],
      ["part", 300],
      ["words.", 550],
      ["Second", 2_000],
      ["part", 2_350],
      ["words.", 2_600],
    ]);
    expect(result.segments).toEqual([
      { id: "s1", startMs: 0, endMs: 850 },
      { id: "s2", startMs: 2_000, endMs: 2_900 },
    ]);
    expect(result).toMatchObject({ durationMs: 4_600, parts: 2, path: join(dir, "voice.mp3") });

    const concat = calls.find((call) => call.args.includes("-filter_complex"));
    expect(concat?.command).toBe("ffmpeg");
    expect(concat?.args).toContain("[0:a][1:a]concat=n=2:v=0:a=1[voice]");
    expect(concat?.args.at(-1)).toBe(join(dir, "voice.mp3"));
  });

  it("writes a single part directly without ffmpeg", async () => {
    const dir = await tempDir();
    const { fetchImpl } = fakeProvider([speak]);
    const { run, calls } = fakeRunner();
    const result = await synthesizeVoice({
      apiKey: testKey(),
      voiceId: "v",
      segments: [{ id: "s1", text: "Just one part." }],
      outputPath: join(dir, "voice.mp3"),
      fetch: fetchImpl,
      run,
      probe: async () => mediaProbe(900),
    });
    expect(calls).toEqual([]);
    expect(await readFile(result.path, "utf8")).toBe("audio:14");
    expect(result.durationMs).toBe(900);
  });

  it("retries 429 and 5xx responses, then succeeds", async () => {
    const dir = await tempDir();
    const { fetchImpl, requests } = fakeProvider([
      () => jsonResponse(429, { detail: "slow down" }, { "retry-after": "2" }),
      () => jsonResponse(503, { detail: "busy" }),
      speak,
    ]);
    const waits: number[] = [];
    const result = await synthesizeVoice({
      apiKey: testKey(),
      voiceId: "v",
      segments: [{ id: "s1", text: "Retry me." }],
      outputPath: join(dir, "voice.mp3"),
      fetch: fetchImpl,
      retry: { baseDelayMs: 100, sleep: async (ms) => void waits.push(ms) },
      probe: async () => mediaProbe(500),
    });
    expect(requests).toHaveLength(3);
    expect(waits).toEqual([2_000, 200]);
    expect(result.alignment.words).toHaveLength(2);
  });

  it("fails without retrying on other errors and never echoes the key", async () => {
    const dir = await tempDir();
    const apiKey = testKey("provider");
    const { fetchImpl, requests } = fakeProvider([
      () => jsonResponse(401, { detail: { status: "invalid_api_key", message: "Invalid key" } }),
    ]);
    const error = await synthesizeVoice({
      apiKey,
      voiceId: "v",
      segments: [{ id: "s1", text: "Hello." }],
      outputPath: join(dir, "voice.mp3"),
      fetch: fetchImpl,
      retry: { sleep: noSleep },
      probe: async () => mediaProbe(500),
    }).catch((e: unknown) => e);
    expect(requests).toHaveLength(1);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).status).toBe(401);
    expect((error as ProviderError).retryable).toBe(false);
    expect((error as Error).message).toContain("HTTP 401");
    expect((error as Error).message).not.toContain(apiKey);
  });

  it("gives up after the last retry with the final status", async () => {
    const { fetchImpl, requests } = fakeProvider([() => jsonResponse(500, { detail: "down" })]);
    const response = await fetchWithRetry(
      fetchImpl,
      "https://provider.test/x",
      { method: "POST", body: "{}" },
      {
        attempts: 3,
        sleep: noSleep,
      },
    );
    expect(response.status).toBe(500);
    expect(requests).toHaveLength(3);
  });

  it("refuses to run without a key, a voice or text", async () => {
    const base = { segments: [{ id: "s1", text: "x" }], outputPath: "/tmp/never.mp3" };
    await expect(synthesizeVoice({ ...base, apiKey: "", voiceId: "v" })).rejects.toThrow(
      /not configured/,
    );
    await expect(synthesizeVoice({ ...base, apiKey: testKey(), voiceId: " " })).rejects.toThrow(
      /voice/,
    );
    await expect(
      synthesizeVoice({
        ...base,
        apiKey: testKey(),
        voiceId: "v",
        segments: [{ id: "s1", text: " " }],
      }),
    ).rejects.toThrow(/no text/);
  });
});

describe("readVoiceProviderKey", () => {
  it("prefers the environment, then the studio .env file", async () => {
    const fromEnv = testKey("env");
    expect(readVoiceProviderKey({ env: { ELEVENLABS_API_KEY: fromEnv }, envFile: "/nope" })).toBe(
      fromEnv,
    );

    const fromFile = testKey("file");
    const envFile = join(await tempDir(), ".env");
    await writeFile(envFile, ["# keys", "OTHER=1", `XI_API_KEY="${fromFile}"`, ""].join("\n"));
    expect(readVoiceProviderKey({ env: {}, envFile })).toBe(fromFile);
    expect(readVoiceProviderKey({ env: {}, envFile: join(envFile, "missing") })).toBeUndefined();
  });
});

describe("transcribeMedia", () => {
  const providerTranscript = {
    language_code: "en",
    text: "Hello world",
    audio_duration_secs: 1.5,
    words: [
      { text: "Hello", type: "word", start: 0.1, end: 0.5 },
      { text: " ", type: "spacing", start: 0.5, end: 0.6 },
      { text: "(laughs)", type: "audio_event", start: 0.6, end: 0.9 },
      { text: "world", type: "word", start: 0.9, end: 1.3 },
    ],
  };

  it("maps word timings and drops spacing and audio events", () => {
    expect(parseTranscript(providerTranscript)).toEqual({
      text: "Hello world",
      languageCode: "en",
      durationMs: 1_500,
      words: [
        { text: "Hello", startMs: 100, endMs: 500 },
        { text: "world", startMs: 900, endMs: 1_300 },
      ],
    });
  });

  it("uploads audio directly with the transcription form fields", async () => {
    const dir = await tempDir();
    const input = join(dir, "clip.mp3");
    await writeFile(input, "fake audio");
    const apiKey = testKey("stt");
    const seen: { url: string; headers: Record<string, string>; form: FormData }[] = [];
    let attempt = 0;
    const transcript = await transcribeMedia({
      apiKey,
      inputPath: input,
      languageCode: "en",
      retry: { sleep: noSleep },
      fetch: async (url, init) => {
        seen.push({
          url,
          headers: init.headers as Record<string, string>,
          form: init.body as FormData,
        });
        attempt += 1;
        return attempt === 1 ? jsonResponse(502, {}) : jsonResponse(200, providerTranscript);
      },
    });
    expect(transcript.words).toHaveLength(2);
    expect(seen).toHaveLength(2);
    expect(seen[0]?.url).toBe("https://api.elevenlabs.io/v1/speech-to-text");
    expect(seen[0]?.headers["xi-api-key"]).toBe(apiKey);
    const form = seen[1]?.form;
    expect(form?.get("model_id")).toBe("scribe_v2");
    expect(form?.get("timestamps_granularity")).toBe("word");
    expect(form?.get("language_code")).toBe("en");
    expect(form?.get("diarize")).toBe("true");
    expect((form?.get("file") as File | undefined)?.name).toBe("clip.mp3");
  });

  it("extracts audio from video with ffmpeg first and cleans up", async () => {
    const dir = await tempDir();
    const input = join(dir, "reference.mov");
    await writeFile(input, "fake video");
    const { run, calls } = fakeRunner();
    await transcribeMedia({
      apiKey: testKey(),
      inputPath: input,
      run,
      fetch: async () => jsonResponse(200, providerTranscript),
    });
    const [extract] = calls;
    expect(extract?.command).toBe("ffmpeg");
    const output = extract?.args.at(-1) ?? "";
    expect(extract?.args).toEqual(extractAudioArgs(input, output));
    expect(extract?.args).toEqual(expect.arrayContaining(["-vn", "-ac", "1", "-ar", "16000"]));
    await expect(readFile(output)).rejects.toThrow();
  });
});
