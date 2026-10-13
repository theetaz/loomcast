import { describe, expect, it } from "vitest";
import { REFERENCE_ANALYSIS_LIMITS as limits, ReferenceAnalysisSchema } from "../src";
import { analysis } from "./fixtures";

const valid = (value: unknown) => ReferenceAnalysisSchema.safeParse(value).success;

describe("reference analysis", () => {
  it("accepts a complete analysis and drops unknown fields", () => {
    expect(ReferenceAnalysisSchema.parse({ ...analysis, verdict: "great" })).toEqual(analysis);
  });

  it("accepts the optional fields left out", () => {
    const { visualStyle: _visualStyle, cta: _cta, ...rest } = analysis;
    const minimal = {
      ...rest,
      hook: { text: "Wait for it", type: "tease" },
      structure: [],
      retention: [],
      pacing: { notes: "" },
    };

    expect(valid(minimal)).toBe(true);
  });

  it.each([
    ["hook text", { hook: { ...analysis.hook, text: "x".repeat(limits.hookText + 1) } }],
    ["hook type", { hook: { ...analysis.hook, type: "x".repeat(limits.hookType + 1) } }],
    ["empty hook text", { hook: { ...analysis.hook, text: "   " } }],
    ["negative time to hook", { hook: { ...analysis.hook, timeToHookMs: -1 } }],
    [
      "too many sections",
      { structure: Array.from({ length: limits.maxSections + 1 }, () => analysis.structure[0]) },
    ],
    [
      "section summary",
      { structure: [{ label: "A", summary: "x".repeat(limits.sectionSummary + 1) }] },
    ],
    ["section label", { structure: [{ label: "x".repeat(81), summary: "s" }] }],
    [
      "section ending before it starts",
      { structure: [{ label: "A", startMs: 5, endMs: 4, summary: "s" }] },
    ],
    [
      "position past one hour",
      { structure: [{ label: "A", endMs: limits.maxPositionMs + 1, summary: "s" }] },
    ],
    ["pacing notes", { pacing: { notes: "x".repeat(limits.pacingNotes + 1) } }],
    ["words per minute", { pacing: { wordsPerMinute: 1_001, notes: "" } }],
    [
      "too many retention notes",
      { retention: Array.from({ length: limits.maxRetention + 1 }, () => analysis.retention[0]) },
    ],
    ["retention evidence", { retention: [{ technique: "t", evidence: "x".repeat(1_001) }] }],
    ["visual style", { visualStyle: "x".repeat(limits.visualStyle + 1) }],
    ["call to action", { cta: "x".repeat(limits.cta + 1) }],
    ["no takeaways", { takeaways: [] }],
    [
      "too many takeaways",
      { takeaways: Array.from({ length: limits.maxTakeaways + 1 }, () => "t") },
    ],
    ["takeaway length", { takeaways: ["x".repeat(limits.takeaway + 1)] }],
    ["applicability", { applicability: "x".repeat(limits.applicability + 1) }],
    ["missing applicability", { applicability: undefined }],
  ])("rejects an over-cap or missing %s", (_name, change) => {
    expect(valid({ ...analysis, ...change })).toBe(false);
  });

  it("accepts every list at its cap", () => {
    const full = {
      ...analysis,
      structure: Array.from({ length: limits.maxSections }, () => analysis.structure[0]),
      retention: Array.from({ length: limits.maxRetention }, () => analysis.retention[0]),
      takeaways: Array.from({ length: limits.maxTakeaways }, () => "x".repeat(limits.takeaway)),
    };

    expect(valid(full)).toBe(true);
  });
});
