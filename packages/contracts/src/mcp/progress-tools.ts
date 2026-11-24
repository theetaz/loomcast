import { z } from "zod";
import { IdSchema } from "../common";
import { ContentProgressSchema, PROGRESS_LIMITS, ProgressReportSchema } from "../pipeline/progress";
import type { McpToolContract } from "./contract";
import { McpWorkspaceRefSchema } from "./research-tools";

export const ProgressReportInputSchema = z.object({
  workspace: McpWorkspaceRefSchema,
  items: z.array(ProgressReportSchema).min(1).max(PROGRESS_LIMITS.reportItems),
});
export type ProgressReportToolInput = z.infer<typeof ProgressReportInputSchema>;

/**
 * What happened to each reported item, in the order given:
 * - `stored`: saved (new, or a higher revision);
 * - `unchanged`: identical to what is stored;
 * - `stale`: an equal or newer revision is stored, so the report was ignored;
 * - `not_found`: no item with that id in the workspace;
 * - `invalid_preview`: the preview is not a ready asset of the item, so nothing was saved.
 */
export const PROGRESS_REPORT_OUTCOMES = [
  "stored",
  "unchanged",
  "stale",
  "not_found",
  "invalid_preview",
] as const;
export const ProgressReportOutcomeSchema = z.enum(PROGRESS_REPORT_OUTCOMES);
export type ProgressReportOutcome = (typeof PROGRESS_REPORT_OUTCOMES)[number];

export const ProgressReportOutputSchema = z.object({
  results: z.array(
    z.object({
      itemId: IdSchema,
      outcome: ProgressReportOutcomeSchema,
      revision: z.number().int().min(0).nullable(),
    }),
  ),
});
export type ProgressReportOutput = z.infer<typeof ProgressReportOutputSchema>;

export const ProgressGetInputSchema = z.object({
  workspace: McpWorkspaceRefSchema,
  itemId: IdSchema,
});
export const ProgressGetOutputSchema = z.object({ progress: ContentProgressSchema.nullable() });

export const ProgressListInputSchema = z.object({ workspace: McpWorkspaceRefSchema });
export const ProgressListOutputSchema = z.object({ items: z.array(ContentProgressSchema) });

export const progressTools = {
  "progress.report": {
    name: "progress.report",
    scope: "mcp:write",
    jobTokens: "deny",
    workspaceBinding: "input",
    description: `Report how up to ${PROGRESS_LIMITS.reportItems} items of a workspace are being made outside Loomcast (for example by Content Machine): each item's steps (idea, research, script, voice, visuals, render, checks, ready, scheduled, published; each pending, active, done, failed or skipped, with the skill and tool used), its checks, a preview asset and the producer's path. A report replaces the item's stored progress only when its revision is higher; never changes the item's pipeline state. Upload a preview first with content.upload_asset (kind poster or render).`,
    input: ProgressReportInputSchema,
    output: ProgressReportOutputSchema,
  },
  "progress.get": {
    name: "progress.get",
    scope: "mcp:read",
    jobTokens: "allow",
    workspaceBinding: "input",
    description:
      "The production progress reported for one item (from progress.report), or null when none was reported.",
    input: ProgressGetInputSchema,
    output: ProgressGetOutputSchema,
  },
  "progress.list": {
    name: "progress.list",
    scope: "mcp:read",
    jobTokens: "allow",
    workspaceBinding: "input",
    description:
      "Every item of a workspace with reported production progress, most recently updated first, with each item's stage (the first failed or running step, else the furthest one done) and health (idle, active, failed or done).",
    input: ProgressListInputSchema,
    output: ProgressListOutputSchema,
  },
} as const satisfies Record<string, McpToolContract>;
