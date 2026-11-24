import { type ContentProgress, completeSteps, progressStage } from "@loomcast/contracts";
import { describe, expect, it } from "vitest";
import { groupByStage, stylesOf } from "../src/features/production/ProductionBoard";

const at = "2026-11-24T10:00:00.000Z";

function progress(
  itemId: string,
  style: string | null,
  steps: Parameters<typeof completeSteps>[0],
): ContentProgress {
  const complete = completeSteps(steps);
  return {
    itemId,
    workspaceId: "00000000-0000-4000-8000-000000000001",
    title: itemId,
    itemState: "idea",
    source: "content-machine",
    path: `brands/unfolded/content/${itemId}`,
    style,
    steps: complete,
    checks: [],
    previewAssetId: null,
    revision: 1,
    inferred: false,
    ...progressStage(complete),
    reportedAt: at,
    updatedAt: at,
  };
}

const step = (key: "idea" | "research" | "script", status: "done" | "active" | "failed") => ({
  key,
  status,
  skill: null,
  tool: null,
  startedAt: null,
  finishedAt: null,
  note: null,
  error: null,
});

describe("production board", () => {
  it("puts each item under its running or failed step, else its furthest done step", () => {
    const columns = groupByStage([
      progress("a", "build-ladder", [step("idea", "done")]),
      progress("b", "build-ladder", [step("idea", "done"), step("research", "failed")]),
      progress("c", null, [
        step("idea", "done"),
        step("research", "done"),
        step("script", "active"),
      ]),
    ]);
    expect(columns).toHaveLength(10);
    expect(columns.find((c) => c.key === "idea")?.items.map((i) => i.itemId)).toEqual(["a"]);
    expect(columns.find((c) => c.key === "research")?.items.map((i) => i.itemId)).toEqual(["b"]);
    expect(columns.find((c) => c.key === "script")?.items.map((i) => i.itemId)).toEqual(["c"]);
  });

  it("lists styles by how often they are used", () => {
    expect(
      stylesOf([
        progress("a", "quiz", []),
        progress("b", "build-ladder", []),
        progress("c", "build-ladder", []),
        progress("d", null, []),
      ]),
    ).toEqual(["build-ladder", "quiz"]);
  });
});
