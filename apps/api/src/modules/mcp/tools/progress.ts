import { type ContentProgress, PROGRESS_STEP_LABELS, progressTools } from "@loomcast/contracts";
import type { ProgressService } from "../../progress/service";
import type { WorkspacesService } from "../../workspaces/service";
import { defineTool, McpToolError, type ToolContext, type ToolDefinition } from "./registry";

export interface ProgressToolsDeps {
  progress: ProgressService;
  workspaces: Pick<WorkspacesService, "get">;
}

/** Most items named one by one in a text summary; the structured result has them all. */
const SUMMARY_LIMIT = 50;

const workspaceNotFound = () => new McpToolError("not_found", "No workspace has that id or slug.");

function boundWorkspace(ctx: ToolContext): string {
  if (ctx.workspaceId === null) {
    throw workspaceNotFound();
  }
  return ctx.workspaceId;
}

function describe(progress: ContentProgress): string {
  return `- ${progress.itemId} "${progress.title}": ${PROGRESS_STEP_LABELS[progress.stage]} (${progress.health}), revision ${progress.revision}`;
}

/** `progress.*` tools: production progress reported from outside Loomcast. */
export function createProgressTools(deps: ProgressToolsDeps): ToolDefinition[] {
  const { progress, workspaces } = deps;

  async function workspaceOf(ref: string): Promise<string | null> {
    return (await workspaces.get(ref))?.id ?? null;
  }

  const report = defineTool(progressTools["progress.report"], {
    resolveWorkspace: (input) => workspaceOf(input.workspace),
    async handler(input, ctx) {
      return { results: await progress.report(boundWorkspace(ctx), input.items) };
    },
    summary: ({ results }) => {
      const counts = new Map<string, number>();
      for (const result of results) {
        counts.set(result.outcome, (counts.get(result.outcome) ?? 0) + 1);
      }
      const parts = [...counts].map(([outcome, count]) => `${count} ${outcome}`);
      const problems = results
        .filter((result) => result.outcome === "not_found" || result.outcome === "invalid_preview")
        .slice(0, SUMMARY_LIMIT)
        .map((result) => `- ${result.itemId}: ${result.outcome}`);
      return [`Progress reports: ${parts.join(", ")}.`, ...problems].join("\n");
    },
  });

  const get = defineTool(progressTools["progress.get"], {
    resolveWorkspace: (input) => workspaceOf(input.workspace),
    async handler(input, ctx) {
      const found = await progress.get(input.itemId);
      return { progress: found?.workspaceId === boundWorkspace(ctx) ? found : null };
    },
    summary: ({ progress: found }) =>
      found === null ? "No progress was reported for that item." : describe(found).slice(2),
  });

  const list = defineTool(progressTools["progress.list"], {
    resolveWorkspace: (input) => workspaceOf(input.workspace),
    async handler(_input, ctx) {
      return { items: await progress.list(boundWorkspace(ctx)) };
    },
    summary: ({ items }) => {
      if (items.length === 0) return "No item of this workspace has reported progress.";
      const lines = items.slice(0, SUMMARY_LIMIT).map(describe);
      const more =
        items.length > SUMMARY_LIMIT ? [`- and ${items.length - SUMMARY_LIMIT} more`] : [];
      return [`${items.length} items with progress:`, ...lines, ...more].join("\n");
    },
  });

  return [report, get, list];
}
