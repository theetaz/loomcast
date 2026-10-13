import type { ReferenceAnalysis } from "@loomcast/contracts";

/** A complete reference analysis, as a producer session returns it. */
export function sampleAnalysis(
  takeaway = "Build the diagram in sync with the voice",
): ReferenceAnalysis {
  return {
    hook: { text: "Here is the whole idea in one picture.", type: "demo-first" },
    structure: [{ label: "Hook", startMs: 0, endMs: 2_000, summary: "One picture." }],
    pacing: { notes: "Fast, no dead air." },
    retention: [{ technique: "Progressive diagram", evidence: "Boxes appear as named." }],
    takeaways: [takeaway],
    applicability: "Use for every architecture explainer.",
  };
}
