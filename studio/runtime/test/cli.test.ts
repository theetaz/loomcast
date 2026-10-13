import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.ts";
import { itemLayout } from "../src/item.ts";
import { tempDir } from "./support.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

function captureOutput() {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    out.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    err.push(String(chunk));
    return true;
  });
  return { out, err };
}

describe("the runtime CLI", () => {
  it("validates a storyboard file and exits 1 on errors", async () => {
    const dir = await tempDir();
    const file = join(dir, "storyboard.json");
    const frame = {
      id: "f1",
      segmentId: "s1",
      startMs: 0,
      endMs: 6_000,
      cardId: "vox-explainer.t1.section.circle",
      slots: { kicker: "A", headline: "B", source: "C" },
    };
    await writeFile(
      file,
      JSON.stringify({ styleId: "vox-explainer", fps: 30, aspect: "9:16", frames: [frame] }),
    );
    const { out } = captureOutput();
    expect(await main(["validate", file])).toBe(0);
    expect(JSON.parse(out.join(""))).toEqual({ ok: true, issues: [] });

    await writeFile(
      file,
      JSON.stringify({
        styleId: "vox-explainer",
        fps: 30,
        aspect: "9:16",
        frames: [{ ...frame, endMs: 1_000 }],
      }),
    );
    out.length = 0;
    expect(await main(["validate", file])).toBe(1);
    expect(JSON.parse(out.join("")).issues[0].code).toBe("frame_too_short");
  });

  it("prints usage for help and unknown commands", async () => {
    const { err } = captureOutput();
    expect(await main(["--help"])).toBe(0);
    expect(err.join("")).toContain("validate <storyboard.json>");
    expect(await main(["nope", "x"])).toBe(1);
  });

  it("lays out a version's workspace", () => {
    expect(itemLayout("/w/v1")).toEqual({
      dir: "/w/v1",
      script: "/w/v1/script.json",
      storyboard: "/w/v1/storyboard.json",
      voice: "/w/v1/voice.mp3",
      alignment: "/w/v1/alignment.json",
      renderDir: "/w/v1/render",
      output: "/w/v1/out/final.mp4",
      poster: "/w/v1/poster.jpg",
    });
  });
});
