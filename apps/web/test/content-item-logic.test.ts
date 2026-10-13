import { ScriptSchema, StoryboardSchema } from "@loomcast/contracts";
import { describe, expect, it } from "vitest";
import {
  refreshDelay,
  URL_MIN_REFRESH_MS,
  URL_REFRESH_MARGIN_MS,
} from "@/features/content-item/asset-url";
import { diffStats, scriptText, wordDiff } from "@/features/content-item/diff";
import { defaultTab } from "@/features/content-item/ItemPage";
import { formatBitRate, formatBytes } from "@/features/content-item/media-format";
import {
  draftFromScript,
  insertSegment,
  isDraftChanged,
  moveSegment,
  removeSegment,
  scriptFromDraft,
  validateDraft,
} from "@/features/content-item/script-draft";
import {
  fitTarget,
  formatSpan,
  formatTimecode,
  frameBar,
  parseCardId,
  scriptDuration,
  timeSegments,
} from "@/features/content-item/timing";
import { stepFrame } from "@/features/content-item/VideoTab";
import { mockScript, mockStoryboard } from "@/mocks/artifacts";

describe("timecodes", () => {
  it("formats positions as mm:ss.t and spans in brackets", () => {
    expect(formatTimecode(0)).toBe("00:00.0");
    expect(formatTimecode(3_240)).toBe("00:03.2");
    expect(formatTimecode(65_960)).toBe("01:06.0");
    expect(formatSpan(3_200, 7_900)).toBe("[00:03.2–00:07.9]");
  });

  it("uses voice timings when present and estimates the rest from words", () => {
    const timed = timeSegments([
      { id: "a", text: "one two three four five", startMs: 0, endMs: 1_800 },
      { id: "b", text: "six seven eight nine ten" },
    ]);
    expect(timed[0]).toMatchObject({ startMs: 0, endMs: 1_800, measured: true });
    // Five words at 2.5 words a second, from where the last one ended.
    expect(timed[1]).toMatchObject({ startMs: 1_800, endMs: 3_800, measured: false });
    expect(scriptDuration({ segments: timed.map((entry) => entry.segment) }).measured).toBe(false);
  });

  it("places lengths against the format's target", () => {
    const target = { min: 30, max: 60 };
    expect(fitTarget(45_000, target)).toEqual({ fit: "within", byMs: 0 });
    expect(fitTarget(64_000, target)).toEqual({ fit: "over", byMs: 4_000 });
    expect(fitTarget(25_000, target)).toEqual({ fit: "under", byMs: 5_000 });
  });

  it("reads tier and purpose from card ids and places frames on the timing bar", () => {
    expect(parseCardId("vox-explainer.t1.section.circle")).toEqual({
      style: "vox-explainer",
      tier: "Tier 1",
      purpose: "section",
    });
    expect(parseCardId("kallaway.t2.lower-third.marker").purpose).toBe("lower third");
    expect(parseCardId("custom")).toEqual({ style: "custom", tier: null, purpose: null });
    expect(frameBar({ startMs: 2_500, endMs: 5_000 }, 10_000)).toEqual({ left: 0.25, width: 0.25 });
  });
});

describe("script diff", () => {
  it("marks removed and added words between two scripts", () => {
    const before = mockScript(3);
    const after = { ...before, hook: before.hook.replace("refuses", "rejects") };
    const parts = wordDiff(scriptText(before), scriptText(after));
    expect(parts.filter((part) => part.kind === "removed").map((part) => part.text.trim())).toEqual(
      ["refuses"],
    );
    expect(parts.filter((part) => part.kind === "added").map((part) => part.text.trim())).toEqual([
      "rejects",
    ]);
    expect(diffStats(parts)).toEqual({ added: 1, removed: 1 });
  });

  it("ignores timings, so a re-recorded voice is not a change", () => {
    const plain = mockScript(2);
    const timed = mockScript(2, { timed: true });
    expect(
      wordDiff(scriptText(plain), scriptText(timed)).every((part) => part.kind === "same"),
    ).toBe(true);
  });
});

describe("script drafts", () => {
  const base = mockScript(1, { timed: true });

  it("round-trips a script without its timings", () => {
    const draft = draftFromScript(base);
    expect(isDraftChanged(draft, base)).toBe(false);
    const saved = scriptFromDraft(draft, base);
    expect(saved.segments.every((segment) => segment.startMs === undefined)).toBe(true);
    expect(ScriptSchema.safeParse(saved).success).toBe(true);
  });

  it("moves, inserts and removes segments", () => {
    const draft = draftFromScript(base);
    const ids = (segments: { id: string }[]) => segments.map((segment) => segment.id);
    expect(ids(moveSegment(draft.segments, 1, -1)).slice(0, 2)).toEqual(["setup", "hook"]);
    expect(ids(moveSegment(draft.segments, 0, -1))).toEqual(ids(draft.segments));
    const { segments, segment } = insertSegment(draft.segments, 0);
    expect(segments[1]).toBe(segment);
    expect(segment.id).toBe("s7");
    expect(removeSegment(segments, 1)).toHaveLength(draft.segments.length);
    expect(removeSegment([segment], 0)).toHaveLength(1);
  });

  it("names the segment a problem is in", () => {
    const draft = draftFromScript(base);
    const blank = {
      ...draft,
      segments: draft.segments.map((s, i) => (i === 2 ? { ...s, text: " " } : s)),
    };
    expect(validateDraft(blank, base)).toBe("Segment 3: The text must not be empty");
    expect(validateDraft(draft, base)).toBeNull();
  });
});

describe("media", () => {
  it("refreshes presigned URLs a minute before they expire, never sooner than a second", () => {
    const now = Date.parse("2026-10-13T10:00:00.000Z");
    const inAnHour = new Date(now + 60 * 60_000).toISOString();
    expect(refreshDelay(inAnHour, now)).toBe(60 * 60_000 - URL_REFRESH_MARGIN_MS);
    expect(refreshDelay(new Date(now + 10_000).toISOString(), now)).toBe(URL_MIN_REFRESH_MS);
    expect(refreshDelay("not a date", now)).toBe(URL_MIN_REFRESH_MS);
  });

  it("steps a video one frame and pauses it", () => {
    let paused = false;
    const video = {
      currentTime: 1,
      duration: 2,
      pause: () => {
        paused = true;
      },
    } as unknown as HTMLVideoElement;
    stepFrame(video, 1, 30);
    expect(video.currentTime).toBeCloseTo(1 + 1 / 30);
    expect(paused).toBe(true);
    video.currentTime = 0;
    stepFrame(video, -1, 30);
    expect(video.currentTime).toBe(0);
  });

  it("opens the tab of the furthest artifact", () => {
    const version = { renderAssetId: null, voiceAssetId: null, hasStoryboard: false };
    expect(defaultTab(version)).toBe("script");
    expect(defaultTab({ ...version, hasStoryboard: true })).toBe("storyboard");
    expect(defaultTab({ ...version, voiceAssetId: "v" })).toBe("voice");
    expect(defaultTab({ ...version, renderAssetId: "r" })).toBe("video");
  });

  it("formats sizes and bit rates", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(8_412_331)).toBe("8.4 MB");
    expect(formatBitRate(1_602_000)).toBe("1.6 Mb/s");
  });

  it("builds mock storyboards the contracts accept", () => {
    expect(StoryboardSchema.safeParse(mockStoryboard(mockScript(3, { timed: true }))).success).toBe(
      true,
    );
  });
});
