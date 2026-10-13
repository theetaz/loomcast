import type { AlignedWord } from "@loomcast/contracts";
import { describe, expect, it } from "vitest";
import { CAPTION_DEFAULTS, chunkCaptions } from "../src/captions.ts";

/** Words spoken back to back, `step` ms apart, each lasting `length` ms. */
function spoken(text: string, start = 0, step = 300, length = 250): AlignedWord[] {
  return text.split(" ").map((word, index) => ({
    text: word,
    startMs: start + index * step,
    endMs: start + index * step + length,
  }));
}

describe("chunkCaptions", () => {
  it("keeps lines to three words and 18 characters, two lines per chunk", () => {
    const chunks = chunkCaptions(spoken("one two three four five six seven eight nine ten"));
    for (const chunk of chunks) {
      expect(chunk.lines.length).toBeLessThanOrEqual(2);
      for (const line of chunk.lines) {
        expect(line.split(" ").length).toBeLessThanOrEqual(3);
        expect(line.length).toBeLessThanOrEqual(18);
      }
    }
    expect(chunks.map((chunk) => chunk.lines)).toEqual([
      ["one two three", "four five six"],
      ["seven eight nine", "ten"],
    ]);
  });

  it("breaks a line on the character limit before the word limit", () => {
    const [chunk] = chunkCaptions(spoken("observability dashboards everywhere"));
    expect(chunk?.lines).toEqual(["observability", "dashboards"]);
  });

  it("gives a word longer than a line its own line", () => {
    const chunks = chunkCaptions(spoken("a supercalifragilisticexpialidocious idea"));
    expect(chunks[0]?.lines).toEqual(["a", "supercalifragilisticexpialidocious"]);
    expect(chunks[1]?.lines).toEqual(["idea"]);
  });

  it("starts a new chunk after a sentence ends or a pause", () => {
    const sentence = chunkCaptions(spoken("It works. Ship it"));
    expect(sentence.map((chunk) => chunk.lines.join(" "))).toEqual(["It works.", "Ship it"]);

    const words = [...spoken("before the pause"), ...spoken("after it", 2_000)];
    const paused = chunkCaptions(words);
    expect(paused.map((chunk) => chunk.lines.join(" "))).toEqual(["before the pause", "after it"]);
  });

  it("keeps every chunk on screen for at least 0.6 s without overlaps", () => {
    // Fast speech: 120 ms per word, with sentence breaks forcing tiny chunks.
    const chunks = chunkCaptions(spoken("Go. Now. Run. Fast. Stop.", 0, 120, 100));
    for (const [index, chunk] of chunks.entries()) {
      expect(chunk.endMs - chunk.startMs).toBeGreaterThanOrEqual(CAPTION_DEFAULTS.minDurationMs);
      const next = chunks[index + 1];
      if (next) expect(next.startMs).toBeGreaterThanOrEqual(chunk.endMs);
    }
  });

  it("bridges short gaps so captions do not flicker, and leaves long ones", () => {
    const words = [...spoken("first part."), ...spoken("second part.", 800)];
    const [first, second] = chunkCaptions(words);
    expect(first?.endMs).toBe(second?.startMs);

    const far = chunkCaptions([...spoken("first part."), ...spoken("second part.", 5_000)]);
    expect(far[0]?.endMs).toBeLessThan(far[1]?.startMs ?? 0);
  });

  it("records each word's timing and line, inside its chunk", () => {
    const [chunk] = chunkCaptions(spoken("one two three four"));
    expect(chunk?.words.map((word) => [word.text, word.line])).toEqual([
      ["one", 0],
      ["two", 0],
      ["three", 0],
      ["four", 1],
    ]);
    for (const word of chunk?.words ?? []) {
      expect(word.startMs).toBeGreaterThanOrEqual(chunk?.startMs ?? 0);
      expect(word.endMs).toBeLessThanOrEqual(chunk?.endMs ?? 0);
    }
  });

  it("skips empty words and accepts custom limits", () => {
    const words = [{ text: "  ", startMs: 0, endMs: 10 }, ...spoken("a b c d", 100)];
    const chunks = chunkCaptions(words, { maxWordsPerLine: 1, maxLines: 1 });
    expect(chunks.map((chunk) => chunk.lines)).toEqual([["a"], ["b"], ["c"], ["d"]]);
    expect(chunkCaptions([])).toEqual([]);
  });
});
