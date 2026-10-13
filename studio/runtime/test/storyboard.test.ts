import { describe, expect, it } from "vitest";
import { loadRegistry } from "../src/registry.ts";
import {
  hasErrors,
  parseStoryboard,
  type StoryboardIssue,
  StoryboardValidationError,
  validateStoryboard,
} from "../src/storyboard.ts";

const registry = loadRegistry();
const CIRCLE = "vox-explainer.t1.section.circle"; // slots kicker 28, headline 70, scrap (image), source 40; 5-8 s

interface Frame {
  id: string;
  segmentId: string;
  startMs: number;
  endMs: number;
  cardId: string;
  slots: Record<string, string>;
}

function frame(overrides: Partial<Frame> = {}): Frame {
  return {
    id: "f1",
    segmentId: "s1",
    startMs: 0,
    endMs: 6_000,
    cardId: CIRCLE,
    slots: { kicker: "Security", headline: "Cracked, not <em>guessed</em>", source: "Reports" },
    ...overrides,
  };
}

function storyboard(frames: Frame[], styleId = "vox-explainer") {
  return { styleId, fps: 30, aspect: "9:16", frames };
}

function codes(issues: StoryboardIssue[]): string[] {
  return issues.map((issue) => issue.code);
}

describe("validateStoryboard", () => {
  it("accepts a storyboard that fits the registry", () => {
    const issues = validateStoryboard(
      storyboard([frame(), frame({ id: "f2", startMs: 6_000, endMs: 12_000 })]),
      registry,
      { voiceDurationMs: 12_000 },
    );
    expect(issues).toEqual([]);
    expect(hasErrors(issues)).toBe(false);
  });

  it("reports unknown styles and cards, and cards from another style", () => {
    const issues = validateStoryboard(
      storyboard(
        [
          frame({ cardId: "vox-explainer.t1.nope" }),
          frame({ id: "f2", startMs: 6_000, endMs: 12_000, cardId: "kallaway.t1.section.ascend" }),
        ],
        "vox-explainer",
      ),
      registry,
    );
    expect(codes(issues)).toEqual(expect.arrayContaining(["unknown_card", "card_style_mismatch"]));
    expect(codes(validateStoryboard(storyboard([frame()], "no-such-style"), registry))).toContain(
      "unknown_style",
    );
  });

  it("checks slots are declared, text-only and within their limits", () => {
    const issues = validateStoryboard(
      storyboard([
        frame({
          slots: { kicker: "k".repeat(29), headline: "fits", bogus: "x", scrap: "an image slot" },
        }),
      ]),
      registry,
    );
    const byCode = Object.fromEntries(issues.map((issue) => [issue.code, issue]));
    expect(byCode.slot_too_long?.path).toEqual(["frames", 0, "slots", "kicker"]);
    expect(byCode.slot_too_long?.message).toContain("at most 28 characters");
    expect(byCode.unknown_slot?.path).toEqual(["frames", 0, "slots", "bogus"]);
    expect(byCode.image_slot?.path).toEqual(["frames", 0, "slots", "scrap"]);
    // The missing source slot is only a warning.
    const missing = issues.filter((issue) => issue.code === "missing_slot");
    expect(missing).toHaveLength(1);
    expect(missing[0]?.severity).toBe("warning");
  });

  it("reports a too-long slot once, in registry terms, even past the contract's cap", () => {
    const issues = validateStoryboard(
      storyboard([frame({ slots: { ...frame().slots, headline: "h".repeat(300) } })]),
      registry,
    );
    const atHeadline = issues.filter((issue) => issue.path.join(".") === "frames.0.slots.headline");
    expect(codes(atHeadline)).toEqual(["slot_too_long"]);
  });

  it("requires frames in order and without overlaps", () => {
    const overlap = validateStoryboard(
      storyboard([frame(), frame({ id: "f2", startMs: 5_000, endMs: 11_000 })]),
      registry,
    );
    expect(overlap.find((issue) => issue.code === "frame_overlap")?.path).toEqual([
      "frames",
      1,
      "startMs",
    ]);
    expect(codes(overlap)).not.toContain("invalid_storyboard");

    const order = validateStoryboard(
      storyboard([
        frame({ startMs: 6_000, endMs: 12_000 }),
        frame({ id: "f2", startMs: 0, endMs: 6_000 }),
      ]),
      registry,
    );
    expect(codes(order)).toContain("frame_order");

    const gap = validateStoryboard(
      storyboard([frame(), frame({ id: "f2", startMs: 6_400, endMs: 12_000 })]),
      registry,
    );
    expect(hasErrors(gap)).toBe(false);
  });

  it("keeps each frame within its card's minimum and maximum", () => {
    expect(codes(validateStoryboard(storyboard([frame({ endMs: 4_999 })]), registry))).toContain(
      "frame_too_short",
    );
    expect(codes(validateStoryboard(storyboard([frame({ endMs: 8_001 })]), registry))).toContain(
      "frame_too_long",
    );
    expect(hasErrors(validateStoryboard(storyboard([frame({ endMs: 5_000 })]), registry))).toBe(
      false,
    );
    expect(hasErrors(validateStoryboard(storyboard([frame({ endMs: 8_000 })]), registry))).toBe(
      false,
    );
  });

  it("refuses frames that run past the voice", () => {
    const sb = storyboard([frame({ endMs: 6_000 })]);
    expect(codes(validateStoryboard(sb, registry, { voiceDurationMs: 5_400 }))).toContain(
      "beyond_voice",
    );
    expect(validateStoryboard(sb, registry, { voiceDurationMs: 5_500 })).toEqual([]);
  });

  it("maps contract failures to invalid_storyboard issues", () => {
    const issues = validateStoryboard(
      { ...storyboard([frame()]), fps: 24, aspect: "16:9" },
      registry,
    );
    expect(
      issues.filter((issue) => issue.code === "invalid_storyboard").map((i) => i.path),
    ).toEqual(expect.arrayContaining([["fps"], ["aspect"]]));
    expect(codes(validateStoryboard(null, registry))).toContain("invalid_storyboard");
    expect(codes(validateStoryboard(storyboard([]), registry))).toContain("invalid_storyboard");
  });

  it("parses a valid storyboard and throws with every issue otherwise", () => {
    expect(parseStoryboard(storyboard([frame()]), registry).frames).toHaveLength(1);
    try {
      parseStoryboard(storyboard([frame({ endMs: 1_000 })]), registry);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(StoryboardValidationError);
      expect((error as StoryboardValidationError).issues.map((i) => i.code)).toContain(
        "frame_too_short",
      );
    }
  });
});
