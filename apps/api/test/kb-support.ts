import { createHash, randomUUID } from "node:crypto";
import type { ReferenceAnalysis } from "@loomcast/contracts";
import { assets, type Database } from "@loomcast/db";

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

/** An uploaded asset row, `ready` `reference_media` unless told otherwise. */
export async function insertAsset(
  db: Database,
  workspaceId: string,
  values: { kind?: "reference_media" | "poster"; status?: "pending" | "ready" } = {},
): Promise<string> {
  const name = randomUUID();
  const [asset] = await db
    .insert(assets)
    .values({
      workspaceId,
      kind: values.kind ?? "reference_media",
      status: values.status ?? "ready",
      bucket: "loomcast-media",
      storageKey: `references/${name}.mp4`,
      filename: `${name}.mp4`,
      mime: "video/mp4",
      bytes: 1_024,
      sha256: createHash("sha256").update(name).digest("hex"),
    })
    .returning({ id: assets.id });
  if (asset === undefined) {
    throw new Error("asset was not inserted");
  }
  return asset.id;
}
